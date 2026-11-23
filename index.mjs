import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const PREFIX = "opencode-subagent";
const MAX_DIAGNOSTIC_BYTES = 4096;
const MAX_JOB_LINE_CHARS = 2000;
const JOB_KIND = "opencode";

const DEFAULTS = {
  providerName: "opencode",
  cliPath: "",
  providerID: "opencode",
  model: "deepseek-v4.1-flash-free",
  // "default" reuses OpenCode's own session (proven free-tier-friendly),
  // "stable" hashes label+cwd into one reusable id, "fresh" creates a new id per run.
  sessionStrategy: "default",
  cwd: "",
  auto: true,
  extraArgs: [],
  runTimeoutMs: 600000,
  terminateTimeoutMs: 5000,
};

const SESSION_STRATEGIES = new Set(["default", "stable", "fresh"]);

function resolveConfig(input = {}) {
  const config = { ...DEFAULTS, ...input };
  for (const key of ["providerName", "providerID", "model", "cliPath", "cwd", "sessionStrategy"]) {
    if (typeof config[key] !== "string") {
      throw new Error(`${PREFIX}: ${key} must be a string`);
    }
  }
  if (!config.providerName || !config.providerID || !config.model) {
    throw new Error(`${PREFIX}: providerName, providerID and model must be non-empty`);
  }
  if (!SESSION_STRATEGIES.has(config.sessionStrategy)) {
    throw new Error(`${PREFIX}: sessionStrategy must be one of ${[...SESSION_STRATEGIES].join(", ")}`);
  }
  if (!Array.isArray(config.extraArgs) || config.extraArgs.some(arg => typeof arg !== "string")) {
    throw new Error(`${PREFIX}: extraArgs must be an array of strings`);
  }
  for (const key of ["runTimeoutMs", "terminateTimeoutMs"]) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) {
      throw new Error(`${PREFIX}: ${key} must be a positive finite number`);
    }
  }
  return config;
}

function resolveCliPath(configured) {
  if (configured) return configured;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      const exe = join(appData, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe");
      if (existsSync(exe)) return exe;
    }
  }
  return "opencode";
}

function assertUsableCwd(label, cwd) {
  if (!isAbsolute(cwd)) {
    throw new Error(`${PREFIX}: ${label} must be an absolute path: ${cwd}`);
  }
  try {
    if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
    accessSync(cwd, constants.X_OK);
  } catch {
    throw new Error(`${PREFIX}: ${label} is not an accessible directory: ${cwd}`);
  }
  return cwd;
}

function promptToText(prompt) {
  const parts = [];
  for (const block of prompt ?? []) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block?.type === "text" && block.text != null) {
      parts.push(String(block.text));
    } else if (block?.type) {
      parts.push(`[non-text content block: ${block.type}]`);
    }
  }
  return parts.join("\n\n");
}

/**
 * Decide which `--session` value (if any) to pass to OpenCode.
 * The free tier treats a brand-new session as a fresh admission and can 429 it
 * (community issue #64334); reusing OpenCode's default session is the proven path.
 */
function resolveOpenCodeSession(config, request) {
  if (config.sessionStrategy === "default") return undefined;
  if (config.sessionStrategy === "fresh") {
    return `ses_${randomUUID().replaceAll("-", "")}`;
  }
  const seed = `${request.label ?? "dsh-subagent"}|${request.cwd ?? config.cwd ?? process.cwd()}`;
  return `ses_${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

function truncateDiagnostic(text) {
  if (!text) return undefined;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= MAX_DIAGNOSTIC_BYTES) return text;
  const suffix = "\n[diagnostic truncated]";
  const suffixBytes = encoder.encode(suffix).byteLength;
  let limit = MAX_DIAGNOSTIC_BYTES - suffixBytes;
  while (limit > 0 && (bytes[limit] & 0b1100_0000) === 0b1000_0000) limit -= 1;
  return new TextDecoder().decode(bytes.subarray(0, limit)) + suffix;
}

/** Buffer stderr / non-JSON stdout without letting it grow without bound. */
class TailBuffer {
  constructor(limit = 8192) {
    this.limit = limit;
    this.value = "";
  }
  push(text) {
    if (!text) return;
    this.value = (this.value + text).slice(-this.limit);
  }
  get() {
    return this.value || undefined;
  }
}

/**
 * Turn one OpenCode `--format json` event into a compact human-readable line
 * for the job output ring. Returns null for events with no visible meaning.
 * `log` channel is observer-only: it never enters the model's job-output cursor.
 */
function describeOpenCodeEvent(event) {
  if (!event || typeof event !== "object") return null;
  const part = event.part && typeof event.part === "object" ? event.part : undefined;
  const type = event.type ?? part?.type;
  if (type === "step_start" || part?.type === "step-start") {
    const title = part?.title ?? part?.step ?? event.step;
    const line = `▶ step${title !== undefined ? ` ${title}` : ""} started`;
    return { line, progress: title !== undefined ? `step ${title}` : "step started" };
  }
  if (type === "text" && typeof part?.text === "string") {
    const text = part.text.replace(/\s+/g, " ").slice(0, MAX_JOB_LINE_CHARS);
    return { line: `💬 ${text}`, progress: "text" };
  }
  if (type === "tool_use" || part?.type === "tool-use") {
    const tool = part?.tool ?? part?.toolName ?? part?.name ?? part?.state?.tool ?? "tool";
    return { line: `🔧 tool: ${tool}`, progress: `tool ${tool}` };
  }
  if (type === "step_finish" || part?.type === "step-finish") {
    const reason = part?.reason ?? part?.finishReason ?? "done";
    return { line: `✓ step finish (${reason})`, progress: "step done" };
  }
  if (type === "error") {
    const message = part?.error?.message ?? event.error?.message ?? event.message ?? JSON.stringify(event);
    return {
      line: `✗ error: ${String(message).slice(0, MAX_JOB_LINE_CHARS)}`,
      progress: "error",
      channel: "stderr",
    };
  }
  return null;
}

class OpenCodeCliProvider {
  constructor(config, logger, ctx) {
    this.name = config.providerName;
    this.config = config;
    this.logger = logger;
    this.ctx = ctx;
    // An out-of-process backend cannot honor parent-enforced start features.
    this.capabilities = Object.freeze({
      agentOptions: false,
      agentPreset: false,
      outputSchema: false,
      depthLimit: false,
    });
    this.inheritsParentContext = false;
  }

  jobsRegistry() {
    try {
      return this.ctx?.jobs ?? null;
    } catch {
      return null;
    }
  }

  async start(request) {
    const cfg = this.config;
    const cwd = assertUsableCwd("cwd", request.cwd || cfg.cwd || process.cwd());
    const prompt = promptToText(request.prompt);
    if (!prompt.trim()) {
      throw new Error(`${PREFIX}: empty prompt`);
    }

    const runId = `ses_${randomUUID().replaceAll("-", "")}`;
    const opencodeSession = resolveOpenCodeSession(cfg, request);
    const label = String(request.label ?? "dsh-subagent").slice(0, 120);
    const args = [
      "run",
      "--model", `${cfg.providerID}/${cfg.model}`,
      "--format", "json",
      ...(opencodeSession ? ["--session", opencodeSession] : []),
      "--title", label,
      ...(cfg.auto ? ["--auto"] : []),
      ...cfg.extraArgs,
      prompt,
    ];
    const cliPath = resolveCliPath(cfg.cliPath);

    // --- job visibility (observer-only, never fed back into the model) -------
    let jobHandle;
    let killChildRef;
    const emitJob = (text, channel = "log") => {
      if (!jobHandle || !text) return;
      try {
        jobHandle.append(String(text).slice(0, MAX_JOB_LINE_CHARS), { channel });
      } catch {
        // A job append must never break the actual subagent run.
      }
    };
    const setProgress = (line) => {
      if (!jobHandle || !line) return;
      try {
        jobHandle.updateProgress(String(line).slice(0, 200));
      } catch {
        // Progress is best-effort.
      }
    };
    let resolveJobDone;
    const jobDone = new Promise(resolve => { resolveJobDone = resolve; });
    const settleJob = result => {
      if (!resolveJobDone) return;
      const status = result?.stopReason === "aborted" ? "killed"
        : result?.stopReason === "error" ? "failed" : "completed";
      const detail = result?.diagnostic
        ? String(result.diagnostic).slice(0, 500)
        : undefined;
      resolveJobDone(detail ? { status, detail } : { status });
      resolveJobDone = undefined;
    };

    // --- actual subprocess execution -----------------------------------------
    const launch = () => {
      const output = [];
      const plainOutput = new TailBuffer();
      const stderr = new TailBuffer();
      const diag = new TailBuffer();
      let spawnError;
      let cancelled = false;
      let timedOut = false;
      let timer;

      const child = spawn(cliPath, args, {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      const pid = child.pid;
      killChildRef = killChild;

      const closePromise = new Promise(resolve => {
        child.once("close", (code, signal) => resolve({ code, signal }));
        child.once("error", error => {
          spawnError = error;
          stderr.push(error?.message);
        });
      });

      function killChild() {
        if (!pid) return;
        try {
          child.kill();
        } catch {
          // The child may already be gone; teardown still awaits `close`.
        }
        if (process.platform === "win32") {
          try {
            const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
              shell: false,
            });
            killer.once("error", () => {});
          } catch {
            // Best effort only.
          }
        }
      }

      timer = setTimeout(() => {
        timedOut = true;
        diag.push("run timeout reached");
        killChild();
      }, cfg.runTimeoutMs);
      timer.unref?.();

      let stdoutBuffer = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", chunk => {
        stdoutBuffer += chunk;
        let index;
        while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
          const line = stdoutBuffer.slice(0, index).trim();
          stdoutBuffer = stdoutBuffer.slice(index + 1);
          if (!line) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            plainOutput.push(line);
            emitJob(line, "stderr");
            continue;
          }
          if (event?.type === "text" && event.part?.type === "text" && typeof event.part.text === "string") {
            output.push({ type: "text", text: event.part.text });
          } else if (event?.type === "error") {
            const message = event.error?.message ?? event.message ?? JSON.stringify(event);
            diag.push(String(message));
          }
          const described = describeOpenCodeEvent(event);
          if (described) {
            emitJob(described.line, described.channel ?? "log");
            setProgress(described.progress);
          }
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", chunk => {
        const text = String(chunk);
        stderr.push(text);
        emitJob(text, "stderr");
      });

      const collectOutput = () => {
        if (output.length > 0) return output.slice();
        return [{ type: "text", text: "(OpenCode produced no text output)" }];
      };
      const collectDiagnostic = () => truncateDiagnostic(
        [diag.get(), stderr.get(), plainOutput.get()].filter(Boolean).join("\n"),
      );
      const onAbort = () => {
        cancelled = true;
        killChild();
      };
      const signal = request.signal;
      if (signal?.aborted) onAbort();
      else signal?.addEventListener?.("abort", onAbort, { once: true });

      const attempt = async () => {
        const { code } = await closePromise;
        clearTimeout(timer);
        if (cancelled) return { output: collectOutput(), stopReason: "aborted" };
        if (spawnError) throw spawnError;
        if (timedOut) throw new Error(`${PREFIX}: run timed out after ${cfg.runTimeoutMs} ms`);
        if (code !== 0) {
          throw new Error(`${PREFIX}: opencode run exited with code ${code}: ${collectDiagnostic() ?? "no diagnostic"}`);
        }
        return { output: collectOutput(), stopReason: "completed" };
      };

      const settleRunResult = async () => {
        try {
          const result = await attempt();
          return cancelled ? { output: collectOutput(), stopReason: "aborted" } : result;
        } catch (error) {
          if (cancelled) return { output: collectOutput(), stopReason: "aborted" };
          const message = error instanceof Error ? error.message : String(error);
          try {
            this.logger?.warn?.(`${PREFIX}: run failed: ${message}`);
          } catch {
            // Diagnostic sink must never reject the run result.
          }
          return {
            output: collectOutput(),
            diagnostic: truncateDiagnostic(message),
            stopReason: "error",
          };
        } finally {
          signal?.removeEventListener?.("abort", onAbort);
        }
      };

      const result = settleRunResult();
      result.then(
        value => settleJob(value),
        error => settleJob({ stopReason: "error", diagnostic: String(error), output: [] }),
      );

      let teardownPromise;
      const teardown = () => {
        if (teardownPromise) return teardownPromise;
        teardownPromise = (async () => {
          clearTimeout(timer);
          if (child.exitCode === null && child.signalCode === null) {
            killChild();
            let raceTimer;
            try {
              await Promise.race([
                closePromise,
                new Promise(resolve => {
                  raceTimer = setTimeout(resolve, cfg.terminateTimeoutMs);
                  raceTimer.unref?.();
                }),
              ]);
            } finally {
              clearTimeout(raceTimer);
            }
          }
        })();
        return teardownPromise;
      };

      let disposed;
      return {
        id: runId,
        result,
        dispose() {
          if (disposed) return disposed;
          signal?.removeEventListener?.("abort", onAbort);
          cancelled = true;
          killChild();
          disposed = teardown();
          return disposed;
        },
      };
    };

    // Register a visible job when the host provides the jobs service. The job
    // row lives in the session header (live progress/output/kill) and is
    // observer-only, so the parent model is not polluted by step-by-step logs.
    let run;
    const jobs = this.jobsRegistry();
    if (jobs) {
      const owner = request.parent?.session?.id;
      try {
        jobs.start({
          kind: JOB_KIND,
          label: `OpenCode · ${label}`,
          ...(owner ? { owner } : {}),
          run(job) {
            jobHandle = job;
            setProgress("starting");
            emitJob(`$ opencode run --model ${cfg.providerID}/${cfg.model} · sessionStrategy=${cfg.sessionStrategy}`);
            run = launch();
            return {
              cancel() {
                setProgress("killed");
                killChildRef?.();
              },
              done: jobDone,
            };
          },
        });
      } catch (error) {
        if (!run) run = launch();
        try {
          this.logger?.warn?.(
            `${PREFIX}: jobs unavailable, running without visible job: ${error?.message ?? error}`,
          );
        } catch {
          // Ignore logger failures.
        }
      }
    } else {
      run = launch();
    }
    return run;
  }
}

export const name = "opencode-subagent";
export const inject = ["subagents", "jobs"];

export function apply(ctx, input = {}) {
  const config = resolveConfig(input);
  const provider = new OpenCodeCliProvider(config, ctx.logger, ctx);
  const unregister = ctx.subagents.registerProvider(provider);
  ctx.effect(() => unregister, `${PREFIX}.unregisterProvider`);
}
