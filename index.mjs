/**
 * `subagent-opencode` — an OpenCode-backed out-of-process subagent provider.
 *
 * Shaped after the official `@deepseek-ai/dsh-subagent-codex` provider: the
 * provider is a thin seam (`start()` -> `SubagentRun`), every run owns exactly
 * one managed child process, and all lifecycle work is delegated to the DSH
 * contracts (`NO_START_CAPABILITIES`, `settleRunResult`, `subprocessRunHandle`,
 * `ctx.subprocess`).
 *
 * The child is `opencode serve`, which speaks HTTP rather than JSON-RPC over
 * stdio (this is what `codex app-server --stdio` does). Readiness is announced
 * on the child's stdout:
 *
 *     server listening on http://127.0.0.1:<port>
 *     server password <token>
 *
 * Every request then carries HTTP Basic auth with username `opencode` and that
 * password. One run is: create session -> subscribe to `GET /api/event` (SSE)
 * -> `POST /api/session/:id/prompt` -> wait for the terminal
 * `session.execution.*` event -> terminate the child.
 */
import { randomUUID } from "node:crypto";

import z from "@deepseek-ai/schemastery";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import {
  NO_START_CAPABILITIES,
  assertPositiveFinite,
  assertUsableCwd,
  settleRunResult,
  subprocessRunHandle,
} from "@deepseek-ai/dsh-subagent";
import { SessionId } from "@deepseek-ai/dsh-session";

/** Registry name of the provider this plugin contributes. */
const PROVIDER_NAME = "opencode";
/** Diagnostic / log prefix (plugin name, not provider name). */
const PREFIX = "subagent-opencode";
/** Env var that carries the resolved batch shim path on Windows. */
const OPENCODE_EXECUTABLE_ENV = "DSH_OPENCODE_EXECUTABLE";
/** Free-tier DeepSeek model: usable without an OpenCode Go subscription. */
const DEFAULT_MODEL = "opencode/deepseek-v4.1-flash-free";
/** `--port 0` asks the OS for a free port, so concurrent runs never collide. */
const SERVE_ARGS = ["serve", "--port", "0", "--hostname", "127.0.0.1"];
const MAX_DIAGNOSTIC_CHARS = 4096;
const MAX_JOB_LINE_CHARS = 2000;
const MAX_STDERR_CHARS = 8192;

export const name = "subagent-opencode";
/**
 * The provider needs `subagents` (to register itself) and `subprocess` (to own
 * the `opencode serve` child). `jobs` is *not* declared here on purpose: the
 * Cordis inject dialect in this DSH line takes a plain service-name array, so
 * an object form would be read literally as two services named "required" and
 * "optional" and the plugin would never activate. Instead the provider looks
 * the service up lazily (`ctx.get("jobs")`); when the host mounts it, a run
 * also publishes an observer-only job row (live progress/output/kill) in the
 * session header. Job output never enters the parent model's context.
 */
export const inject = ["subagents", "subprocess"];

export const Config = z.object({
  /** Explicit child environment overlay; values here survive the parent scrub. */
  env: z.dict(z.string()).default({}),
  /** Grace period handed to the subprocess service for each child. */
  disposeGraceMs: z.number().default(3_000),
  /** `<providerID>/<modelID>` inside OpenCode. */
  model: z.string().default(DEFAULT_MODEL),
  /** OpenCode executable name or absolute path, resolved by the subprocess service. */
  executable: z.string().default("opencode"),
  /** Fail a run when the local server has not announced readiness by then. */
  startupTimeoutMs: z.number().default(30_000),
  /** Fail a turn that never reaches a terminal execution event. */
  turnTimeoutMs: z.number().default(900_000),
  /** Session title reported by OpenCode. */
  title: z.string().default("dsh-subagent-opencode"),
});

/** ---------- small helpers ---------- */

/** Split `<providerID>/<modelID>` at the first slash. */
function parseModelRef(value) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`${PREFIX}: model must be "<providerID>/<modelID>": ${value}`);
  }
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
}

/** Flatten the delegated content blocks into the plain text OpenCode accepts. */
function promptToText(prompt) {
  const parts = [];
  for (const block of prompt ?? []) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type === "text" && block.text != null) parts.push(String(block.text));
    else if (block?.type) parts.push(`[non-text content block: ${block.type}]`);
  }
  return parts.join("\n\n");
}

function truncateDiagnostic(text) {
  if (!text) return undefined;
  return text.length > MAX_DIAGNOSTIC_CHARS
    ? `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}\n[diagnostic truncated]`
    : text;
}

/** Bounded tail buffer: keeps the last N characters of a stream. */
class TailBuffer {
  constructor(limit = MAX_STDERR_CHARS) {
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

/** Best-effort human message out of an OpenCode error payload. */
function describeError(data) {
  if (!data || typeof data !== "object") return "OpenCode execution failed";
  const candidate =
    data.error?.message ?? data.message ?? data.error?.type ?? data.error?._tag ?? data._tag;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate.slice(0, 500)
    : "OpenCode execution failed";
}

function raceDeadline(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Build the spawn spec for `opencode serve`.
 *
 * On Windows npm exposes the CLI as `opencode.cmd`, which cannot be exec'd
 * directly: it needs the `cmd.exe` batch shim, exactly like the official
 * claude-code provider. The command travels through the environment (not the
 * argv tail), so no path or task text crosses a shell parsing boundary.
 */
function opencodeSpawnSpec({ command, cwd, env, graceMs }) {
  const dot = command.lastIndexOf(".");
  const extension = dot >= 0 ? command.slice(dot).toLowerCase() : "";
  const batchShim = process.platform === "win32" && (extension === ".cmd" || extension === ".bat");
  const childEnv = { ...env };
  const argv = batchShim
    ? ["cmd.exe", "/d", "/v:off", "/s", "/c", `%${OPENCODE_EXECUTABLE_ENV}%`, ...SERVE_ARGS]
    : [command, ...SERVE_ARGS];
  if (batchShim) childEnv[OPENCODE_EXECUTABLE_ENV] = JSON.stringify(command);
  // The spec matches `SubprocessSpawnSpec` exactly: readiness is bounded by the
  // plugin's own raceDeadline, not by a (nonexistent) spawn-time option.
  return {
    argv,
    cwd,
    stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    graceMs,
    env: childEnv,
  };
}

/** ---------- the local OpenCode server ---------- */

/**
 * Owns one `opencode serve` child for the lifetime of a single run: readiness
 * handshake, auth header, session creation, SSE subscription, prompt dispatch,
 * interrupt, and the teardown ladder.
 */
class OpenCodeServer {
  constructor(spec, job) {
    this.spec = spec;
    this.job = job;
    this.child = undefined;
    this.base = undefined;
    this.authorization = undefined;
    this.sessionId = undefined;
    this.stderr = new TailBuffer();
    this.eventsAbort = undefined;
    this.exited = undefined;
    this.closed = undefined;
  }

  emit(text, channel = "log") {
    if (!this.job || !text) return;
    try {
      this.job.append(String(text).slice(0, MAX_JOB_LINE_CHARS), { channel });
    } catch {
      // Job output is observer-only: it must never break the run.
    }
  }

  progress(line) {
    if (!this.job || !line) return;
    try {
      this.job.updateProgress(String(line).slice(0, 200));
    } catch {
      // Progress is best-effort.
    }
  }

  async start(signal) {
    let command;
    try {
      command = await this.spec.resolveExecutable(this.spec.executable, this.spec.env, signal);
    } catch (error) {
      throw new Error(
        `${PREFIX}: cannot resolve the "opencode" executable (${describeError({ error })}). ` +
          `Install the OpenCode CLI or set the "executable" option to its absolute path.`,
      );
    }
    const spawnSpec = opencodeSpawnSpec({
      command,
      cwd: this.spec.cwd,
      env: this.spec.env,
      graceMs: this.spec.disposeGraceMs,
    });
    this.emit(`$ ${command} ${SERVE_ARGS.join(" ")}`);
    const child = this.spec.spawn(spawnSpec);
    this.child = child;
    this.exited = child.done.then(
      (outcome) => outcome,
      (error) => ({ exitCode: null, signal: null, error }),
    );

    const ready = new Promise((resolve, reject) => {
      let pending = "";
      let announced = false;
      let base;
      let password;

      const finish = () => {
        if (announced || base === undefined || password === undefined) return;
        announced = true;
        this.base = base;
        this.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
        resolve();
      };

      const consume = (line) => {
        const listening = /^server listening on (http:\/\/\S+)/.exec(line);
        if (listening) base = listening[1];
        const secret = /^server password (\S+)/.exec(line);
        if (secret) password = secret[1];
        finish();
      };

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        pending += chunk;
        let index;
        while ((index = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, index).trim();
          pending = pending.slice(index + 1);
          if (line.length > 0) consume(line);
        }
      });
      child.stdout?.on("end", () => {
        if (pending.trim().length > 0) consume(pending.trim());
      });
      // The server writes its own diagnostics to stderr; keep a bounded tail
      // for failure detail and mirror it into the visible job row.
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        const text = String(chunk);
        this.stderr.push(text);
        this.emit(text, "stderr");
      });
      void this.exited.then((outcome) => {
        if (announced) return;
        const detail = this.stderr.get();
        reject(
          new Error(
            `${PREFIX}: opencode serve exited before announcing readiness ` +
              `(code ${outcome?.exitCode ?? "null"})${detail ? `: ${detail.slice(-600)}` : ""}`,
          ),
        );
      });
    });

    await raceDeadline(
      ready,
      this.spec.startupTimeoutMs,
      `${PREFIX}: opencode serve did not become ready within ${this.spec.startupTimeoutMs} ms`,
    );

    const created = await this.request("POST", "/api/session", {
      title: this.spec.title,
      location: { directory: this.spec.cwd },
      model: this.spec.model,
    });
    if (created.status !== 200) {
      throw new Error(
        `${PREFIX}: OpenCode refused to create a session (HTTP ${created.status}): ` +
          `${String(created.text).slice(0, 600)}`,
      );
    }
    const sessionId = created.json?.data?.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error(`${PREFIX}: OpenCode returned no session id: ${String(created.text).slice(0, 600)}`);
    }
    this.sessionId = sessionId;
    this.emit(`session ${sessionId} (${this.spec.model.providerID}/${this.spec.model.id})`);
  }

  async request(method, path, body) {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: this.authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { status: response.status, text, json };
  }

  /**
   * Subscribe to the server-wide event stream. Resolves once the stream is
   * established, so the caller can publish the prompt without racing events.
   */
  subscribe(onEvent) {
    const abort = new AbortController();
    this.eventsAbort = abort;
    const ready = (async () => {
      const response = await fetch(`${this.base}/api/event`, {
        headers: { authorization: this.authorization, accept: "text/event-stream" },
        signal: abort.signal,
      });
      if (response.status !== 200 || response.body === null) {
        throw new Error(`${PREFIX}: OpenCode event stream refused (HTTP ${response.status})`);
      }
      void (async () => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let index;
            while ((index = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
              if (line === undefined) continue;
              let event;
              try {
                event = JSON.parse(line.slice(5).trim());
              } catch {
                continue;
              }
              try {
                onEvent(event);
              } catch {
                // A listener error must not tear down the stream.
              }
            }
          }
        } catch {
          // Abort and server shutdown both land here; both are expected.
        }
      })();
    })();
    return ready;
  }

  async prompt(text) {
    const response = await this.request("POST", `/api/session/${this.sessionId}/prompt`, { text });
    if (response.status !== 200) {
      throw new Error(
        `${PREFIX}: OpenCode refused the prompt (HTTP ${response.status}): ${String(response.text).slice(0, 600)}`,
      );
    }
  }

  async interrupt() {
    if (this.sessionId === undefined || this.base === undefined) return;
    try {
      await this.request("POST", `/api/session/${this.sessionId}/interrupt`);
    } catch {
      // Cancellation is best-effort; teardown still terminates the child.
    }
  }

  /** Teardown ladder: stop the stream, then terminate the child to exit. */
  close() {
    if (this.closed !== undefined) return this.closed;
    this.closed = (async () => {
      try {
        this.eventsAbort?.abort();
      } catch {
        // Already aborted.
      }
      const child = this.child;
      if (child === undefined) return;
      try {
        child.stdin?.end();
      } catch {
        // Child may already be gone.
      }
      try {
        child.terminate();
      } catch {
        // Child may already be gone.
      }
      try {
        await raceDeadline(
          child.waitForExit(),
          this.spec.disposeGraceMs,
          `${PREFIX}: timed out waiting for the child to exit`,
        );
      } catch {
        // Exit facts are not needed here.
      }
      try {
        await raceDeadline(
          child.done,
          this.spec.disposeGraceMs,
          `${PREFIX}: timed out waiting for the child outcome`,
        );
      } catch {
        // Spawn/exit failures are already reported through the run result.
      }
    })();
    return this.closed;
  }
}

/** ---------- one run ---------- */

/**
 * Establish one OpenCode execution for a resolved start request.
 * @returns the published `SubagentRun`.
 */
async function startOpenCodeRun(request, spec, job) {
  const prompt = promptToText(request.prompt);
  if (prompt.trim().length === 0) throw new Error(`${PREFIX}: empty prompt`);

  const server = new OpenCodeServer(spec, job);
  server.progress("starting");
  try {
    await server.start(request.signal);
  } catch (error) {
    await server.close();
    throw error;
  }

  // --- turn state --------------------------------------------------------
  const textByMessage = new Map();
  let turnOutcome;
  let settleTurn;
  const turnDone = new Promise((resolve) => {
    settleTurn = resolve;
  });
  let cancelled = false;

  const events = (event) => {
    const type = event?.type;
    const data = event?.data ?? {};
    if (typeof data.sessionID === "string" && data.sessionID !== server.sessionId) return;
    switch (type) {
      case "session.text.delta": {
        if (typeof data.delta !== "string") return;
        const id = typeof data.assistantMessageID === "string" ? data.assistantMessageID : "assistant";
        textByMessage.set(id, (textByMessage.get(id) ?? "") + data.delta);
        return;
      }
      case "session.text.ended": {
        const id = typeof data.assistantMessageID === "string" ? data.assistantMessageID : "assistant";
        const text = (textByMessage.get(id) ?? "").replace(/\s+/g, " ").trim();
        if (text.length > 0) server.emit(`💬 ${text.slice(0, 300)}`);
        return;
      }
      case "session.step.started": {
        server.emit("▶ step started");
        server.progress("step");
        return;
      }
      case "session.tool.input.started": {
        // The tool name is carried by `tool.input.started`; `tool.called`
        // reports the call after execution and carries no name.
        const tool = typeof data.name === "string" ? data.name : "tool";
        server.emit(`🔧 ${tool}`);
        server.progress(`tool ${tool}`);
        return;
      }
      case "session.tool.success": {
        server.progress("tool done");
        return;
      }
      case "session.retry.scheduled": {
        server.emit(`↻ retry scheduled${data.attempt ? ` (attempt ${data.attempt})` : ""}`, "stderr");
        return;
      }
      case "session.execution.succeeded": {
        turnOutcome = { status: "completed" };
        server.progress("done");
        settleTurn();
        return;
      }
      case "session.execution.failed": {
        turnOutcome = { status: "failed", message: describeError(data) };
        server.progress("failed");
        settleTurn();
        return;
      }
      case "session.execution.interrupted": {
        turnOutcome = { status: "interrupted" };
        settleTurn();
        return;
      }
      default:
        return;
    }
  };

  try {
    await server.subscribe(events);
    await server.prompt(prompt);
  } catch (error) {
    await server.close();
    throw error;
  }

  const output = () => {
    let last = "";
    for (const text of textByMessage.values()) {
      if (typeof text === "string" && text.trim().length > 0) last = text;
    }
    return [{ type: "text", text: last.length > 0 ? last : "(OpenCode produced no text output)" }];
  };
  const diagnostic = () => {
    const parts = [];
    if (turnOutcome?.status === "failed" && turnOutcome.message) parts.push(turnOutcome.message);
    const stderr = server.stderr.get();
    if (stderr) parts.push(stderr.trim());
    return truncateDiagnostic(parts.filter(Boolean).join("\n"));
  };

  const signal = request.signal;
  const onAbort = () => {
    cancelled = true;
    void server.interrupt();
    settleTurn();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  const attempt = async () => {
    const exited = server.exited.then(() => {
      throw new Error(`${PREFIX}: opencode serve exited before the turn finished`);
    });
    await raceDeadline(
      Promise.race([turnDone, exited]),
      spec.turnTimeoutMs,
      `${PREFIX}: the turn produced no terminal execution event within ${spec.turnTimeoutMs} ms`,
    );
    if (turnOutcome?.status === "failed") throw new Error(turnOutcome.message ?? "OpenCode execution failed");
    if (turnOutcome?.status === "interrupted") return { output: output(), stopReason: "aborted" };
    return { output: output(), stopReason: "completed" };
  };

  const result = settleRunResult({
    attempt,
    collectOutput: output,
    collectDiagnostic: diagnostic,
    cancelled: () => cancelled,
    onError: (error, stopReason) => {
      spec.onError(error, stopReason);
    },
    signal,
    onAbort,
  });

  let teardownPromise;
  const teardown = () => {
    if (teardownPromise !== undefined) return teardownPromise;
    teardownPromise = (async () => {
      try {
        await server.close();
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    })();
    return teardownPromise;
  };

  return subprocessRunHandle({
    id: SessionId(randomUUID()),
    result,
    signal,
    onAbort,
    requestCancel: () => {
      cancelled = true;
      settleTurn();
    },
    teardown,
  });
}

/** ---------- the provider ---------- */

class OpenCodeProvider {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.name = PROVIDER_NAME;
    // Out-of-process children cannot honor parent-enforced start features.
    this.capabilities = NO_START_CAPABILITIES;
    this.inheritsParentContext = false;
  }

  jobsRegistry() {
    try {
      // `jobs` is not in our inject list (see the inject comment), so ask the
      // context directly; absent service means the host simply has no jobs UI.
      return this.ctx.get?.("jobs") ?? this.ctx.jobs ?? null;
    } catch {
      return null;
    }
  }

  async start(request) {
    const cwd = assertUsableCwd(
      PREFIX,
      "child working directory",
      request.cwd ?? request.parent?.session?.header?.cwd ?? process.cwd(),
    );
    const spec = {
      cwd,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      executable: this.config.executable,
      startupTimeoutMs: this.config.startupTimeoutMs,
      turnTimeoutMs: this.config.turnTimeoutMs,
      title: this.config.title,
      model: parseModelRef(this.config.model),
      spawn: (spawnSpec) => this.ctx.subprocess.spawn(spawnSpec),
      resolveExecutable: (command, env, signal) =>
        this.ctx.subprocess.resolveExecutable(command, env, signal),
      onError: (error, stopReason) => {
        try {
          this.ctx.logger?.warn?.(`${PREFIX}: child run failed (${stopReason}): ${error.message}`);
        } catch {
          // Logging must never reject a run result.
        }
      },
    };

    const jobs = this.jobsRegistry();
    if (jobs === null) return startOpenCodeRun(request, spec, undefined);

    // Publish the run as an observer-only job row, then hand the same run back.
    let release;
    const published = new Promise((resolve, reject) => {
      release = { resolve, reject };
    });
    let jobDone;
    const done = new Promise((resolve) => {
      jobDone = resolve;
    });
    let runRef;
    const onOutcome = (value) => {
      const status =
        value?.stopReason === "completed" ? "completed" : value?.stopReason === "aborted" ? "killed" : "failed";
      jobDone(value?.diagnostic ? { status, detail: String(value.diagnostic).slice(0, 500) } : { status });
    };
    try {
      jobs.start({
        kind: "opencode",
        label: `OpenCode · ${String(request.label ?? "subagent").slice(0, 120)}`,
        ...(request.parent?.session?.id ? { owner: request.parent.session.id } : {}),
        run(handle) {
          void startOpenCodeRun(request, spec, handle).then(
            (run) => {
              runRef = run;
              release.resolve(run);
              void run.result.then(onOutcome, (error) => {
                jobDone({ status: "failed", detail: String(error?.message ?? error).slice(0, 500) });
              });
            },
            (error) => {
              release.reject(error);
              jobDone({ status: "failed", detail: String(error?.message ?? error).slice(0, 500) });
            },
          );
          return {
            cancel() {
              try {
                handle.updateProgress("killed");
              } catch {
                // Ignore: cancellation of a job row is best-effort.
              }
              void runRef?.dispose();
            },
            done,
          };
        },
      });
    } catch (error) {
      try {
        this.ctx.logger?.warn?.(`${PREFIX}: jobs unavailable, running without a visible job: ${error?.message ?? error}`);
      } catch {
        // Ignore logger failures.
      }
      return startOpenCodeRun(request, spec, undefined);
    }
    return published;
  }
}

export function apply(ctx, input = {}) {
  assertPositiveFinite(PREFIX, "disposeGraceMs", input.disposeGraceMs);
  assertPositiveFinite(PREFIX, "startupTimeoutMs", input.startupTimeoutMs);
  assertPositiveFinite(PREFIX, "turnTimeoutMs", input.turnTimeoutMs);
  if (input.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${PREFIX}: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  parseModelRef(input.model);
  const provider = new OpenCodeProvider(ctx, input);
  const unregister = ctx.subagents.registerProvider(provider);
  ctx.effect(() => unregister, `${PREFIX}.unregisterProvider`);
}
