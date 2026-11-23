# dsh-opencode-subagent

[English](#english) · [中文](#中文)

A [DeepSeek Harness](https://github.com/DeepSeek-AI) (DSH) Host plugin that registers a native `SubagentProvider` (name `opencode`) and delegates sub-agent work to the **OpenCode CLI**, so a parent model can spawn real, multi-step sub-agents that run on OpenCode's free models.

It is a zero-dependency, host-only Cordis bundle. No API keys are stored by the plugin — it reuses the OpenCode CLI's own login/session on the machine.

---

## English

### What it does

- Registers an external `SubagentProvider` named `opencode` into DSH.
- Each delegation runs `opencode run --model opencode/<model> --format json` in a child process.
- The OpenCode CLI connects to the user's shared background OpenCode server, so **multi-step reasoning and tool calls work** (it is not a one-shot prompt).
- Streams each step (`step_start`, `text`, `tool_use`, `step_finish`, `error`) into a DSH **job**, so the whole run is visible in the Web UI session header (live progress, expandable output, kill button) without polluting the parent model's context.
- Reuses OpenCode's default session by default (`sessionStrategy: default`) — this is deliberate, because the free tier rate-limits brand-new sessions much more aggressively.

### Why a subprocess instead of the embedded SDK / a direct OpenAI-compatible endpoint

OpenCode's free chat models are only available **inside a real OpenCode runtime**. The official wording:

> "Free-tier chat models require OpenCode; use paid models or Go from other clients."

Directly configuring the free model as a normal OpenAI-compatible DSH provider is therefore rejected (HTTP 403). The embedded `@opencode/sdk` host does not pick up the Console login on all machines either (it reports `provider.no-route`). Driving the `opencode` CLI reuses the exact login state and shared server that the OpenCode desktop client uses, which is the reliable way to run free models.

### Prerequisites

- A working DSH installation with the Agent Teams / subagents machinery (this is a Host bundle).
- [OpenCode CLI](https://opencode.ai) installed and logged in, so that `opencode run --model opencode/hy4-flash-free "hi"` works from a terminal.
- The DSH profile should have the `jobs` stack enabled for the live progress view: `jobs`, `tool-jobs`, `job-controller`, `ui-jobs`. Without it, the plugin still works but falls back to a plain run with no visible job row.
- Node.js that DSH supports (the plugin itself uses only Node built-ins).

### Install as a DSH plugin

Install the bundle into your active profile with the DSH plugin manager:

```powershell
plugin_manager install_bundle --target <path-to-this-repo>
```

Or add it manually to your profile's `package.json` dependencies and `dsh.profile.bundles`, then apply this patch (also shipped as `cordis.patch.yml` inside the bundle):

```yaml
- insert:
    - id: opencode-subagent
      name: '@local/dsh-opencode-subagent'
      config: {}
    - id: tool-opencode-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: opencode
        toolName: opencode_subagent
        maxDepth: provider-managed
```

The first row registers the provider. The second row exposes it to the model as the `opencode_subagent` tool. `maxDepth: provider-managed` is required because an out-of-process backend advertises all `capabilities: false`.

> **Package name:** the npm package is intentionally scoped as `@local/dsh-opencode-subagent`. If you want to publish/rename it, change `name` in `package.json` **and** the `name:` fields in `cordis.patch.yml` to the same value before installing.

Restart DSH once after installation so the new bundle is loaded.

### Usage

Ask the parent model to delegate, e.g. *"use opencode_subagent to list the files in this repo and summarize them"*. A job row named `OpenCode · <label>` appears in the session header; expand it to watch the steps live.

### Configuration

Passed via the bundle `config` in `cordis.patch.yml`.

| Key | Default | Description |
| --- | --- | --- |
| `providerName` | `opencode` | Provider name registered into `ctx.subagents`. |
| `cliPath` | auto | OpenCode CLI path. On Windows it auto-detects `%APPDATA%\npm\node_modules\@opencode\cli\bin\opencode.exe`; otherwise `opencode` from `PATH`. |
| `providerID` | `opencode` | Provider segment of `--model`. |
| `model` | `hy4-flash-free` | Model segment of `--model` (any OpenCode model id works, free or paid). |
| `sessionStrategy` | `default` | `--session` policy: `default` = do not pass (reuse OpenCode's default session, free-tier friendly); `stable` = fixed id from `sha256(label+cwd)`; `fresh` = new random id each run. |
| `cwd` | empty | Fallback working directory when the request does not provide one. |
| `auto` | `true` | Whether to pass `--auto` (allow tool execution without approval). |
| `extraArgs` | `[]` | Extra arguments appended to `opencode run`. |
| `runTimeoutMs` | `600000` | Per-run timeout. |
| `terminateTimeoutMs` | `5000` | Grace period before force-killing the child on dispose. |

### Design notes

- **Visibility without context pollution.** Job output is appended on the `log` channel, which is observer-only: the UI shows it, but the model's consuming read does not include it. The child's final answer still returns through the normal subagent settlement.
- **Out-of-process contract.** `capabilities` are all `false`, `inheritsParentContext = false`, and `prepareContinuable` is not implemented — this is a fire-and-forget external backend. Failures and cancellation always resolve to `stopReason: 'error' | 'aborted'` with a `diagnostic` capped at 4096 bytes, never a rejected promise.
- **Graceful degradation.** If the `jobs` service is unavailable, the plugin logs a warning and runs the delegation normally without a visible job row.

### Privacy

The plugin stores no credentials and sends no data anywhere itself — it only spawns the local `opencode` CLI and parses its JSON output. Model/provider selection and any API keys live entirely in your OpenCode profile. Do not paste secrets into delegation prompts.

### License

MIT — see [LICENSE](LICENSE).

---

## 中文

### 它能做什么

- 向 DSH 注册一个名为 `opencode` 的外部 `SubagentProvider`。
- 每次委托都在子进程里运行 `opencode run --model opencode/<model> --format json`。
- OpenCode CLI 会连接当前用户的共享后台 server，因此**多步推理和工具调用都能正常工作**（不是一次性问答）。
- 把每一步（step_start / text / tool_use / step_finish / error）实时写进 DSH 的 **job**，于是整个运行在 Web UI 的 session-header 里可见（实时进度、可展开输出、可 kill），又不会污染父模型的上下文。
- 默认复用 OpenCode 默认会话（`sessionStrategy: default`）——这是刻意为之，因为免费池对新建会话的限流要激进得多。

### 为什么用子进程，而不是内嵌 SDK / 直连 OpenAI-compatible 端点

OpenCode 的免费聊天模型**只能在真正的 OpenCode 运行时里使用**。官方原话：

> "Free-tier chat models require OpenCode; use paid models or Go from other clients."

所以把免费模型直接配成普通 OpenAI-compatible 的 DSH provider 会被拒（HTTP 403）。内嵌 `@opencode/sdk` host 在部分机器上也不加载 Console 登录态（会报 `provider.no-route`）。而驱动 `opencode` CLI 复用的正是 OpenCode 客户端使用的登录态和共享 server，这是运行免费模型最可靠的方式。

### 前置条件

- 可用的 DSH 安装（含 subagents / Agent Teams 机制，这是 Host bundle）。
- 已安装并登录 [OpenCode CLI](https://opencode.ai)，能在终端里跑通 `opencode run --model opencode/hy4-flash-free "hi"`。
- DSH profile 建议启用 `jobs` 全套以获得实时进度视图：`jobs`、`tool-jobs`、`job-controller`、`ui-jobs`。未启用也能用，只是没有可见的 job 行。
- DSH 支持的 Node.js（插件本身只用 Node 内置模块）。

### 作为 DSH 插件安装

用 DSH 插件管理器把本仓库安装进当前 profile：

```powershell
plugin_manager install_bundle --target <本仓库路径>
```

或手动加入 profile 的 `package.json` dependencies 与 `dsh.profile.bundles`，再应用如下 patch（bundle 内也自带 `cordis.patch.yml`）：

```yaml
- insert:
    - id: opencode-subagent
      name: '@local/dsh-opencode-subagent'
      config: {}
    - id: tool-opencode-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: opencode
        toolName: opencode_subagent
        maxDepth: provider-managed
```

第一行注册 provider，第二行把它作为 `opencode_subagent` 工具暴露给模型。`maxDepth: provider-managed` 是必需的，因为外部后端的 `capabilities` 全为 `false`。

> **包名：** npm 包名刻意保持 `@local/dsh-opencode-subagent`。如需改名发布，请同时修改 `package.json` 的 `name` 和 `cordis.patch.yml` 里的 `name:`，保持一致后再安装。

安装后重启 DSH 一次以加载新 bundle。

### 用法

让父模型委托即可，例如"用 opencode_subagent 列出本仓库文件并总结"。session-header 会出现一行 `OpenCode · <label>` 的任务，展开即可实时观看步骤。

### 配置

通过 `cordis.patch.yml` 里 bundle 的 `config` 传入。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `providerName` | `opencode` | 注册到 `ctx.subagents` 的 provider 名 |
| `cliPath` | 自动探测 | OpenCode CLI 路径；Windows 自动探测 `%APPDATA%\npm\node_modules\@opencode\cli\bin\opencode.exe`，否则用 `PATH` 里的 `opencode` |
| `providerID` | `opencode` | `--model` 的 provider 段 |
| `model` | `hy4-flash-free` | `--model` 的模型 ID（任意 OpenCode 模型均可，免费或付费） |
| `sessionStrategy` | `default` | `--session` 策略：`default` 不传（复用默认会话，对免费池友好）；`stable` 用 `sha256(label+cwd)` 前 32 位固定 ID；`fresh` 每次新建随机 ID |
| `cwd` | 空 | 请求未提供工作目录时的兜底目录 |
| `auto` | `true` | 是否传 `--auto`（允许免确认执行工具） |
| `extraArgs` | `[]` | 追加给 `opencode run` 的额外参数 |
| `runTimeoutMs` | `600000` | 单次运行超时 |
| `terminateTimeoutMs` | `5000` | dispose 时强制 kill 子进程前的等待时长 |

### 设计说明

- **可见但不污染上下文。** job 输出写在 `log` channel，只对观察者可见：UI 能看到，模型的 consuming read 不包含它。子代理最终答案仍走正常的 settlement 回传。
- **外部执行契约。** `capabilities` 全 `false`、`inheritsParentContext=false`、不实现 `prepareContinuable`——这是一个 fire-and-forget 的外部后端。失败与取消都会 resolve 成 `stopReason: 'error' | 'aborted'` 并附不超过 4096 字节的 `diagnostic`，永不 reject。
- **优雅降级。** 若 `jobs` 服务不可用，插件会记一条 warning 并照常执行委托，只是没有可见的 job 行。

### 隐私

插件不存储任何凭据，自身也不向外发送任何数据——它只启动本地 `opencode` CLI 并解析其 JSON 输出。模型/供应商选择与任何 API key 完全留在你的 OpenCode profile 里。不要把密钥写进委托 prompt。

### 许可

MIT — 见 [LICENSE](LICENSE)。
