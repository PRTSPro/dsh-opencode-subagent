# dsh-opencode-subagent

[English](#english) · [中文](#中文)

An [OpenCode](https://opencode.ai)-backed sub-agent provider for **DeepSeek Harness (DSH)**, built to the exact shape of the official `@deepseek-ai/dsh-subagent-codex` and `@deepseek-ai/dsh-subagent-claude-code` providers: it registers a native `SubagentProvider` named `opencode` into the `subagents` service, owns its child process through the `subprocess` service, and registers its own `opencode_subagent` delegation tool through the `tools` service.

Version 0.2.0 was a rewrite. 0.1.x shelled out to `opencode run` once per delegation; 0.2.0 drives a **managed `opencode serve` HTTP server** over OpenCode's v2 API with SSE event streaming, which is the closest OpenCode equivalent of Codex's `app-server --stdio` and Claude Code's agent SDK transport.

Version 0.3.0 replaces the official `@deepseek-ai/dsh-tool-subagent` wrapper with a tool of its own that delegates with `delivery: 'caller'`. External children have no local DSH session, so every `delivery: 'parent'` delegation appends a sub-agent panel tab that can never be opened; `'caller'` delivery keeps runs out of that panel entirely. The trade-off is that the tool is synchronous: its result is the child's final answer.

---

## English

### How it works

```
parent session
  └─ opencode_subagent tool                     ← registered by this plugin (delivery: 'caller')
       └─ OpenCodeProvider.start(request)          ← same contract as the official providers
            ├─ resolve cwd  (request.cwd → parent.session.header.cwd)
            ├─ spawn a managed `opencode serve --port 0 --hostname 127.0.0.1`
            │     └─ ctx.subprocess.spawn({ argv, cwd, stdio, graceMs, env })
            ├─ read stdout: `server listening on http://127.0.0.1:<port>`
            │               `server password <token>`
            ├─ POST /api/session        { title, location.directory, model }
            ├─ GET  /api/event          (SSE, server-sent events)
            ├─ POST /api/session/:id/prompt   { text }
            ├─ wait for session.execution.succeeded | failed | interrupted
            ├─ settleRunResult({ attempt, collectOutput, cancelled, signal, onAbort })
            └─ subprocessRunHandle({ id, result, signal, onAbort, requestCancel, teardown })
```

Each run gets its own server process, its own OpenCode session, and its own cleanup path. The child answers with the text of the final assistant message; intermediate steps are streamed but never enter the parent model's context.

### What it reuses from the official providers

| Piece | Source |
| --- | --- |
| `SubagentProvider` shape (`name`, `capabilities = NO_START_CAPABILITIES`, `inheritsParentContext = false`) | `@deepseek-ai/dsh-subagent` |
| `settleRunResult` / `subprocessRunHandle` settlement helpers | `@deepseek-ai/dsh-subagent` |
| `assertPositiveFinite` / `assertUsableCwd` input guards | `@deepseek-ai/dsh-subagent` |
| Managed child lifetime, env scrubbing, executable resolution | `@deepseek-ai/dsh-subprocess` |
| `MAX_TIMER_DELAY_MS` bound for `disposeGraceMs` | `@deepseek-ai/dsh-timeout` |
| `SessionId` branding for the run id | `@deepseek-ai/dsh-session` |
| `defineTool` / `ctx.tools.register` for the delegation tool | `@deepseek-ai/dsh-tools` |
| `Config` schema dialect (`z.object({...})`) | `@deepseek-ai/schemastery` |
| Windows `.cmd` batch shim (`cmd.exe /d /v:off /s /c "%DSH_OPENCODE_EXECUTABLE%" …`) | same trick as the official Claude Code provider |

Because these are the host's own packages, the plugin stays small and behaves like a first-party provider: cancellation, timeouts, diagnostics, and disposal all follow the same contract.

### Requirements

- A DSH installation whose `dsh-subagent` line exposes the out-of-process helpers above (validated against `0.2.2-rc.5`), with the `subagents`, `subprocess`, and `tools` services mounted.
- The [OpenCode CLI](https://opencode.ai) installed and logged in. Verify:
  ```powershell
  opencode models | Select-String deepseek-v4.1-flash-free
  ```
- A model available to you inside OpenCode. The default is the free `opencode/deepseek-v4.1-flash-free`; any other `provider/model` from `opencode models` works too.
- Optional: the DSH `jobs` stack (`jobs`, `tool-jobs`, `job-controller`, `ui-jobs`) for the live progress row in the session header.

### Install

Install the bundle into the active profile:

```powershell
plugin_manager install_bundle --target <path-to-this-repo>
```

Or add it by hand to the profile's `package.json` (`dependencies` + `dsh.profile.bundles`) and apply the patch that ships in `cordis.patch.yml`:

```yaml
- insert:
    - id: opencode-subagent
      name: '@local/dsh-opencode-subagent'
      config: {}
```

That single entry registers the provider **and** the `opencode_subagent` tool. No `@deepseek-ai/dsh-tool-subagent` wrapper is needed (and none should be added: it delegates with `delivery: 'parent'`, which fills the sub-agent panel with tabs that cannot be opened).

If you would rather keep the official wrapper, set `toolName: ''` in the bundle config and mount `@deepseek-ai/dsh-tool-subagent` yourself with `provider: opencode`, `toolName: opencode_subagent`, `maxDepth: provider-managed`. You then get asynchronous delegation, at the cost of one unopenable sub-agent tab per call.

> **Package name:** the npm package is intentionally scoped as `@local/dsh-opencode-subagent`. To publish it under your own scope, change `name` in `package.json` **and** every `name:` in `cordis.patch.yml` to the same value before installing.

Restart DSH once after installing so the bundle is loaded.

### Usage

Ask the parent model to delegate, for example:

> Use `opencode_subagent` to list the files in this repository and summarize what it is.

The tool is **synchronous**: it returns the child's final answer as its tool result, so the parent can use it directly in the same step. Nothing is added to the sub-agent panel (see `delivery: 'caller'` below). When the `jobs` service is mounted, a row named `OpenCode · <label>` appears in the session header with live step/tool output and a kill button.

Steps are reported as: `▶ step started`, `🔧 <tool name>`, `💬 <assistant text>`, `✓ step finish (reason)`, `✗ error: …`.

### Configuration

Passed through the bundle `config`:

| Key | Default | Description |
| --- | --- | --- |
| `model` | `opencode/deepseek-v4.1-flash-free` | `<providerID>/<modelID>` inside OpenCode. |
| `executable` | `opencode` | Command name or absolute path, resolved by `ctx.subprocess.resolveExecutable`. |
| `env` | `{}` | Extra child environment overlay; values here survive the parent scrub. |
| `disposeGraceMs` | `3000` | Grace period for terminating the child; must be `<= MAX_TIMER_DELAY_MS`. |
| `startupTimeoutMs` | `30000` | Fail the run if the server has not announced readiness by then. |
| `turnTimeoutMs` | `900000` | Fail a turn that never reaches a terminal execution event. |
| `title` | `dsh-subagent-opencode` | Session title reported to OpenCode. |
| `toolName` | `opencode_subagent` | Name of the delegation tool this plugin registers. `''` disables it (use the official wrapper instead). |

### Contract behavior

- `capabilities` is `NO_START_CAPABILITIES` (all `false`) and `inheritsParentContext = false` — an out-of-process backend cannot honor parent-enforced start features.
- Failures and cancellation resolve to `stopReason: "error" | "aborted"` with a `diagnostic` capped at 4096 chars; the run promise never rejects.
- `stopReason` mapping: `session.execution.succeeded → completed`, `failed → error`, `interrupted`/abort → `aborted`.
- Disposal closes the SSE stream, ends stdin, terminates the process tree, then waits for exit and `done` — each wait bounded by `disposeGraceMs` so a half-dead server can never hang `dispose()`.
- The tool delegates with `delivery: 'caller'`: DSH does not append a sub-agent catalog entry (no panel tab, no auto name) and does not inject a settlement notice — the caller awaits the activation result instead. Cancelling the tool call disposes the activation, which tears the child process down.

### Why not talk to OpenCode's models directly?

OpenCode's free tier is only available **inside a real OpenCode runtime**:

> "Free-tier chat models require OpenCode; use paid models or Go from other clients."

Configuring a free model as a plain OpenAI-compatible provider is rejected, so this plugin keeps a real OpenCode process in the loop and speaks its native v2 API instead.

### Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `cannot resolve the "opencode" executable` | CLI not on `PATH`. Install it, or set `executable` to an absolute path. |
| `401 {"_tag":"UnauthorizedError"}` | The per-run server prints its own password; only this plugin's HTTP client should call it. If you see this in a manual probe, use Basic auth `opencode:<password printed on stdout>`. |
| Run stays at `▶ step started` | The model is rate-limited or the provider needs a login. Check `opencode models` and run the same model once in a terminal. |
| No job row in the UI | The profile does not mount the `jobs` stack; the run still works. |
| A dead, unopenable tab appears in the sub-agent panel | Something is delegating with `delivery: 'parent'` — usually the official `@deepseek-ai/dsh-tool-subagent`. External children have no local DSH session, so DSH disables their tab on purpose (`mode: 'external'`). Remove that wrapper; this plugin's own tool does not catalog runs. |
| Windows: child exits immediately | `opencode.cmd` must go through the `cmd.exe` shim; the plugin does this automatically — make sure `executable` points at the launcher, not at a `.ps1`. |

### Privacy

The plugin stores no credentials and sends nothing anywhere itself. It starts the local `opencode` executable, and OpenCode uses its own login/profile on your machine. Model selection and API keys live entirely in your OpenCode configuration. Do not paste secrets into delegation prompts.

### License

MIT — see [LICENSE](LICENSE).

---

## 中文

> 0.3.0 起，插件自带 `opencode_subagent` 工具（`delivery: 'caller'`），不再依赖官方 `@deepseek-ai/dsh-tool-subagent` 包装。外部子代理在 DSH 侧没有本地会话，`delivery: 'parent'` 的每次委托都会往「子智能体」面板追加一个打不开的标签；用 `'caller'` 投递则完全不进该面板。代价是工具变成同步语义：返回值就是子代理的最终答案。

### 工作原理

```
父会话
  └─ opencode_subagent 工具                        ← 本插件自己注册（delivery: 'caller'）
       └─ OpenCodeProvider.start(request)          ← 与官方 provider 完全同一份契约
            ├─ 解析工作目录（request.cwd → parent.session.header.cwd）
            ├─ 受管启动 `opencode serve --port 0 --hostname 127.0.0.1`
            │     └─ ctx.subprocess.spawn({ argv, cwd, stdio, graceMs, env })
            ├─ 读 stdout：`server listening on http://127.0.0.1:<port>`
            │              `server password <token>`
            ├─ POST /api/session        { title, location.directory, model }
            ├─ GET  /api/event          （SSE 服务端事件流）
            ├─ POST /api/session/:id/prompt   { text }
            ├─ 等待 session.execution.succeeded | failed | interrupted
            ├─ settleRunResult({ attempt, collectOutput, cancelled, signal, onAbort })
            └─ subprocessRunHandle({ id, result, signal, onAbort, requestCancel, teardown })
```

每次委托都有独立的 server 进程、独立的 OpenCode 会话和独立的清理路径。子代理最终答案取最后一条 assistant 消息的文本；中间步骤只做流式展示，不进父模型上下文。

### 复用的官方件

| 组件 | 来源 |
| --- | --- |
| `SubagentProvider` 形态（`name`、`capabilities = NO_START_CAPABILITIES`、`inheritsParentContext = false`） | `@deepseek-ai/dsh-subagent` |
| `settleRunResult` / `subprocessRunHandle` 结算辅助 | `@deepseek-ai/dsh-subagent` |
| `assertPositiveFinite` / `assertUsableCwd` 入参校验 | `@deepseek-ai/dsh-subagent` |
| 受管子进程生命周期、环境变量清洗、可执行文件解析 | `@deepseek-ai/dsh-subprocess` |
| `MAX_TIMER_DELAY_MS`（`disposeGraceMs` 上界） | `@deepseek-ai/dsh-timeout` |
| 运行 id 的 `SessionId` 品牌类型 | `@deepseek-ai/dsh-session` |
| 委托工具的 `defineTool` / `ctx.tools.register` | `@deepseek-ai/dsh-tools` |
| `Config` 的 `z.object({...})` 声明方言 | `@deepseek-ai/schemastery` |
| Windows `.cmd` 批处理垫片（`cmd.exe /d /v:off /s /c "%DSH_OPENCODE_EXECUTABLE%" …`） | 与官方 Claude Code provider 相同的做法 |

因为这些就是宿主自己的包，插件本体很小，行为也像一方 provider：取消、超时、诊断、释放全部沿用同一套契约。

### 前置条件

- DSH 安装中的 `dsh-subagent` 提供上述 out-of-process 辅助函数（已在 `0.2.2-rc.5` 上验证），且挂载了 `subagents`、`subprocess`、`tools` 服务。
- 已安装并登录 [OpenCode CLI](https://opencode.ai)。自检：
  ```powershell
  opencode models | Select-String deepseek-v4.1-flash-free
  ```
- OpenCode 内可用的模型。默认用免费的 `opencode/deepseek-v4.1-flash-free`；`opencode models` 里的任意 `provider/model` 都可以。
- 可选：DSH 的 `jobs` 全套（`jobs`、`tool-jobs`、`job-controller`、`ui-jobs`），用于 session-header 里的实时进度行。

### 安装

用插件管理器把本仓库装进当前 profile：

```powershell
plugin_manager install_bundle --target <本仓库路径>
```

或手动加入 profile 的 `package.json`（`dependencies` 与 `dsh.profile.bundles`），再应用 bundle 自带的 `cordis.patch.yml`：

```yaml
- insert:
    - id: opencode-subagent
      name: '@local/dsh-opencode-subagent'
      config: {}
```

这一行同时注册 provider 与 `opencode_subagent` 工具，不需要（也不应再加）`@deepseek-ai/dsh-tool-subagent` 包装——它用 `delivery: 'parent'` 委托，会往「子智能体」面板塞满打不开的标签。

若确实想保留官方包装：把 bundle 配置里的 `toolName` 设为 `''`，再自行挂载 `@deepseek-ai/dsh-tool-subagent`（`provider: opencode`、`toolName: opencode_subagent`、`maxDepth: provider-managed`）。那样能换回异步委托，代价是每次调用多一个打不开的标签。

> **包名：** npm 包名刻意保持 `@local/dsh-opencode-subagent`。若要发布到你自己的 scope，请同时修改 `package.json` 的 `name` 与 `cordis.patch.yml` 里的所有 `name:`，保持一致后再安装。

安装后重启 DSH 一次以加载新 bundle。

### 用法

让父模型委托即可，例如：

> 用 `opencode_subagent` 列出本仓库的文件，并总结这个仓库是做什么的。

工具是**同步**的：返回值就是子代理的最终答案，父模型可以在同一步里直接使用。它不会在「子智能体」面板留下任何标签（见下文 `delivery: 'caller'`）。挂载了 `jobs` 服务时，session-header 会出现一行 `OpenCode · <label>`，可展开看实时步骤/工具输出，也可直接 kill。

步骤展示：`▶ step started`、`🔧 <工具名>`、`💬 <助手文本>`、`✓ step finish (reason)`、`✗ error: …`。

### 配置

通过 bundle 的 `config` 传入：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `model` | `opencode/deepseek-v4.1-flash-free` | OpenCode 内的 `<providerID>/<modelID>` |
| `executable` | `opencode` | 命令名或绝对路径，由 `ctx.subprocess.resolveExecutable` 解析 |
| `env` | `{}` | 追加给子进程的环境覆盖，这些值不会被父环境清洗掉 |
| `disposeGraceMs` | `3000` | 终止子进程的宽限时长，必须 `<= MAX_TIMER_DELAY_MS` |
| `startupTimeoutMs` | `30000` | server 未在此时间内宣告就绪则判失败 |
| `turnTimeoutMs` | `900000` | 一整轮未到达终结事件则判失败 |
| `title` | `dsh-subagent-opencode` | 报给 OpenCode 的会话标题 |
| `toolName` | `opencode_subagent` | 本插件注册的委托工具名。设为 `''` 则不注册（改回用官方包装） |

### 契约行为

- `capabilities = NO_START_CAPABILITIES`（全 `false`）、`inheritsParentContext = false`——外部进程后端无法兑现由父方强制的 start 特性。
- 失败与取消都会 resolve 成 `stopReason: "error" | "aborted"` 并附不超过 4096 字符的 `diagnostic`，run promise 永不 reject。
- `stopReason` 映射：`session.execution.succeeded → completed`、`failed → error`、`interrupted`/abort → `aborted`。
- 释放顺序：关闭 SSE、结束 stdin、终止进程树，再等退出与 `done`；每个等待都被 `disposeGraceMs` 封顶，半死的 server 不会挂住 `dispose()`。
- 委托走 `delivery: 'caller'`：DSH 不写子代理 catalog（面板无标签、无自动命名），也不注入结算通知——由调用方 await activation 的结果。取消该工具调用会 dispose activation，从而回收子进程。

### 为什么不直接调 OpenCode 的模型

OpenCode 免费层**只能在真正的 OpenCode 运行时里使用**。官方原话：

> "Free-tier chat models require OpenCode; use paid models or Go from other clients."

把免费模型配成普通 OpenAI-compatible provider 会被拒，所以本插件始终保留一个真实的 OpenCode 进程，直接和它的 v2 API 对话。

### 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `cannot resolve the "opencode" executable` | CLI 不在 `PATH`。装好，或把 `executable` 设成绝对路径 |
| `401 {"_tag":"UnauthorizedError"}` | 每次运行的 server 会自己打印密码，只有本插件的 HTTP 客户端该调它。手动探测请用 Basic auth `opencode:<stdout 打印的密码>` |
| 一直停在 `▶ step started` | 模型被限流或该 provider 需要登录。检查 `opencode models`，在终端里先用同一模型跑一次 |
| UI 里没有 job 行 | 该 profile 没挂 `jobs` 栈，运行本身仍然正常 |
| 「子智能体」面板出现打不开的标签 | 有人在用 `delivery: 'parent'` 委托——通常是官方 `@deepseek-ai/dsh-tool-subagent`。外部子代理在 DSH 侧没有本地会话，DSH 会刻意禁用它的标签（`mode: 'external'`）。去掉那个包装即可；本插件自带的工具不写 catalog |
| Windows：子进程立刻退出 | `opencode.cmd` 必须经 `cmd.exe` 垫片，插件已自动处理；确认 `executable` 指向启动器而不是 `.ps1` |

### 隐私

插件不存储任何凭据，自身也不向外发送数据。它只启动本机的 `opencode` 可执行文件，登录态与 profile 完全由 OpenCode 自己管理；模型与 API key 都留在你的 OpenCode 配置里。不要把密钥写进委托 prompt。

### 许可

MIT — 见 [LICENSE](LICENSE)。
