import { spawn, spawnSync } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const PREFIX = "opencode-subagent";
const MAX_DIAGNOSTIC_BYTES = 4096;
const MAX_JOB_LINE_CHARS = 2000;
const JOB_KIND = "opencode";
const PARENT_PROBE_INTERVAL_MS = 2000; // parent-death sentinel cadence
const LEDGER_DIRNAME = "_state/opencode_jobs";

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

/** Sanitize an untrusted id into a single safe path segment. */
function safeSegment(value) {
  return String(value ?? "default").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "default";
}

/**
 * Observer ledger location, chosen so agent-visible cwd is never polluted.
 * Priority: DSH-provided session dir -> os.tmpdir() scoped by DSH_SESSION_ID.
 * (This host exposes DSH_SESSION_ID/DSH_HOME but no DSH_SESSION_DIR, so the
 * tmpdir branch is the live path; see delivery report.)
 */
function resolveLedgerDir(request) {
  const envDir = process.env.DSH_SESSION_DIR;
  if (envDir && isAbsolute(envDir)) return join(envDir, LEDGER_DIRNAME);
  const sessionKey = process.env.DSH_SESSION_ID || request?.parent?.session?.id || "default";
  return join(tmpdir(), PREFIX, safeSegment(sessionKey), LEDGER_DIRNAME);
}

/** Append one JSON line. Ledger is observer-only: never break a run on I/O error. */
function ledgerAppend(dir, record) {
  if (!dir) return undefined;
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `jobs-${new Date().toISOString().slice(0, 10)}.jsonl`);
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n", "utf8");
    return file;
  } catch {
    return undefined;
  }
}

// Process-level orphan guard. One shared hook set; one kill callback per live
// child. Exit handlers must be synchronous, so killChild supports a sync mode.
const activeChildren = new Set();
let exitHooksInstalled = false;
function installExitHooks() {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  const killAll = ({ sync = false } = {}) => {
    for (const kill of [...activeChildren]) {
      try {
        kill({ sync });
      } catch {
        // One bad child must not block the others.
      }
    }
  };
  // 'exit' cannot be async: use synchronous taskkill.
  process.once("exit", () => killAll({ sync: true }));
  // Installing a signal listener suppresses Node's default termination, so
  // re-raise after synchronous cleanup to preserve normal shutdown semantics.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.once(signal, () => {
      killAll({ sync: true });
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : 129);
      }
    });
  }
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
    let runPid;
    const ledgerDir = resolveLedgerDir(request);
    const ledgerMeta = {
      runId,
      pid: null,
      parentSessionId: request.parent?.session?.id ?? null,
      label,
      status: "started",
      startedAt: new Date().toISOString(),
    };
    let jobId = null;
    let ledgerStarted = false;
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
    // Mark the observer ledger with the terminal status. This is the second
    // (status) line paired with the "started" line written after jobs.start().
    const recordLedgerStatus = status => {
      ledgerAppend(ledgerDir, {
        ...ledgerMeta,
        jobId,
        pid: runPid ?? ledgerMeta.pid,
        status,
        finishedAt: new Date().toISOString(),
      });
    };
    const settleJob = result => {
      if (!resolveJobDone) return;
      const status = result?.stopReason === "aborted" ? "killed"
        : result?.stopReason === "error" ? "failed" : "completed";
      const detail = result?.diagnostic
        ? String(result.diagnostic).slice(0, 500)
        : undefined;
      recordLedgerStatus(status);
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
      let sentinelTimer;

      // detached puts the child in its own process group (Windows: new process
      // group) so it is not tied to the parent console; stdio pipes stay open
      // for event streaming. The whole tree is still killed explicitly below.
      const child = spawn(cliPath, args, {
        cwd,
        windowsHide: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      const pid = child.pid;
      runPid = pid;
      ledgerMeta.pid = pid;
      // Capture the parent pid inside launch, right after spawn (per task).
      // The liveness sentinel probes it with process.kill(ppid, 0).
      const ppid = process.ppid;
      killChildRef = killChild;

      const closePromise = new Promise(resolve => {
        child.once("close", (code, signal) => resolve({ code, signal }));
        child.once("error", error => {
          spawnError = error;
          stderr.push(error?.message);
        });
      });

      function killChild({ sync = false } = {}) {
        if (!pid) return;
        try {
          child.kill();
        } catch {
          // The child may already be gone; teardown still awaits `close`.
        }
        if (process.platform === "win32") {
          const taskkillArgs = ["/PID", String(pid), "/T", "/F"];
          if (sync) {
            // 'exit' and signal hooks cannot await: use synchronous tree kill.
            try {
              spawnSync("taskkill", taskkillArgs, {
                windowsHide: true,
                stdio: "ignore",
                shell: false,
              });
            } catch {
              // Best effort only.
            }
          } else {
            try {
              const killer = spawn("taskkill", taskkillArgs, {
                windowsHide: true,
                stdio: "ignore",
                shell: false,
              });
              killer.once("error", () => {});
            } catch {
              // Best effort only.
            }
          }
        } else if (pid > 0) {
          // POSIX: detached child is a process-group leader; kill the group.
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // Best effort only.
          }
        }
      }
      // Register with the shared process-level orphan guard.
      activeChildren.add(killChild);
      installExitHooks();

      timer = setTimeout(() => {
        timedOut = true;
        diag.push("run timeout reached");
        killChild();
      }, cfg.runTimeoutMs);
      timer.unref?.();

      // Parent-death sentinel: probe process.ppid every 2s. If the baseline
      // probe already fails, process.ppid is unreliable on this host and we
      // fall back to the process 'exit'/signal hooks only (no false positives).
      let sentinelReliable = true;
      try {
        process.kill(ppid, 0);
      } catch {
        sentinelReliable = false;
      }
      let parentMisses = 0;
      if (sentinelReliable) {
        sentinelTimer = setInterval(() => {
          let alive = true;
          try {
            process.kill(ppid, 0);
          } catch {
            alive = false;
          }
          if (alive) {
            parentMisses = 0;
            return;
          }
          // Require two consecutive misses (~4s) to avoid transient races.
          parentMisses += 1;
          if (parentMisses < 2) return;
          diag.push("parent process gone; killing child tree");
          killChild();
          try { setProgress("killed"); } catch { /* best effort */ }
          try { settleJob({ stopReason: "aborted" }); } catch { /* best effort */ }
          void teardown();
        }, PARENT_PROBE_INTERVAL_MS);
        sentinelTimer.unref?.();
      }

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
        value => { settleJob(value); void teardown(); },
        error => {
          settleJob({ stopReason: "error", diagnostic: String(error), output: [] });
          void teardown();
        },
      );

      let teardownPromise;
      const teardown = () => {
        if (teardownPromise) return teardownPromise;
        // Stop probing and unregister synchronously (idempotent), even if the
        // async body still has to await the child's close below. Unregistering
        // prevents a recycled pid from being killed by a later exit hook.
        clearTimeout(timer);
        if (sentinelTimer) {
          clearInterval(sentinelTimer);
          sentinelTimer = undefined;
        }
        activeChildren.delete(killChild);
        teardownPromise = (async () => {
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

    // Write the paired "started" ledger line exactly once, after both jobId
    // and pid are known (jobs.start invokes run() synchronously).
    const writeLedgerStarted = () => {
      if (ledgerStarted) return;
      ledgerStarted = true;
      ledgerAppend(ledgerDir, {
        ...ledgerMeta,
        jobId,
        pid: runPid ?? null,
        status: "started",
      });
    };

    // Register a visible job when the host provides the jobs service. The job
    // row lives in the session header (live progress/output/kill) and is
    // observer-only, so the parent model is not polluted by step-by-step logs.
    let run;
    const jobs = this.jobsRegistry();
    if (jobs) {
      const owner = request.parent?.session?.id;
      try {
        // jobs.start synchronously invokes run(job) and returns the JobId.
        // Keep it: the original code discarded it, so the job was invisible to
        // ctx.jobs.wait/list and could not be correlated in the ledger.
        jobId = jobs.start({
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
    // `jobs.start()` has returned by now, so jobId is final. If the host
    // invoked run() synchronously (the observed contract), pid is set too;
    // otherwise the settle line still carries it. Either way the started line
    // records the correlation keys without blocking the run.
    writeLedgerStarted();
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
