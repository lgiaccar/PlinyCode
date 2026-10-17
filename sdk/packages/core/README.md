# [experimental] @plinycode/core

`@plinycode/core` is the stateful orchestration layer of the Cline SDK. It
connects the agent runtime, provider settings, storage, default tools, and
session lifecycle into a host-ready runtime.

## What You Get

- session lifecycle and orchestration primitives
- provider settings services
- default runtime tools and MCP integration
- storage-backed session state helpers
- host-facing Node helpers through `@plinycode/core`

## Installation

```bash
npm install @plinycode/core
```

## Entry Points

- `@plinycode/core`: core contracts, shared utilities, and Node/server helpers for building hosts and runtimes

## Typical Usage

Most host apps should start with `@plinycode/core`.

```ts
import { ClineCore } from "@plinycode/core";

const cline = await ClineCore.create({});

const result = await cline.start({
	config: {
		providerId: "anthropic",
		modelId: "claude-sonnet-4-6",
		apiKey: process.env.ANTHROPIC_API_KEY ?? "",
		cwd: process.cwd(),
		mode: "act",
		enableTools: true,
		enableSpawnAgent: false,
		systemPrompt: "You are a concise assistant.",
	},
	prompt: "Summarize this project.",
	interactive: false,
});

console.log(result.result?.text);
await cline.dispose();
```

When both `cwd` and `workspaceRoot` are omitted, the execution host places
the session in the shared chat workspace at
`<cline-data-dir>/workspaces/chat` (by default
`~/.cline/data/workspaces/chat`), seeded with an `AGENTS.md` rules file that
tells the agent to treat the session as a chat and only create a named
project folder when the user asks for one.
Read the resolved paths from `result.manifest.cwd` and
`result.manifest.workspace_root`.

## Session Bootstrap

`ClineCore.create(...)` also accepts `prepare(input)`.

Use it when a host needs to prepare workspace-scoped runtime state before each
session starts, then apply watcher/extensions inputs through
explicit `localRuntime` bootstrap fields without widening the shared host
contract.

Preparation runs before the execution host resolves an omitted workspace, so
pathless starts expose neither `cwd` nor `workspaceRoot` to `prepare(input)`.

## Main APIs

### Runtime and Sessions

Use `@plinycode/core` for host-facing runtime assembly:

- `ClineCore.create(...)`
- `createRuntimeHost(...)`
- `LocalRuntimeHost`
- `DefaultRuntimeBuilder`

`ClineCore` is the app-facing session API. The lower-level `RuntimeHost`
boundary uses runtime-primitive names such as `startSession` and `runTurn` so
transport adapters stay distinct from product methods like `start` and `send`.
Service-style operations such as pending prompt edits, accumulated usage lookup,
and active-session model switching are exposed through `ClineCore` when the
selected transport supports them rather than being part of the minimal host
primitive vocabulary.

### Hook Files

When a session's `localRuntime.configExtensions` includes `"hooks"` (the
default), the engine runs hook files named after their event (`TaskStart`,
`TaskResume`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `TaskComplete`,
`TaskCancel`, `TaskError`, `SessionShutdown`) from the directories
`resolveHooksConfigSearchPaths(workspace)` returns. `listHookConfigFiles(workspace)`
lists them. Two `localRuntime` options let a host control and observe them:

- `hookFilter(hookPath)`: return `false` to skip a hook file. It is evaluated
  each time the file would run, so a host can toggle one hook, or all of them,
  while a session is live. A filter that throws lets the hook run.
- `onHookStatus(event)`: receives `running` before each hook file runs, then
  `completed`, `failed` or `cancelled` (a PreToolUse or PostToolUse hook that
  returned `{"cancel": true}`), with the hook name and path, the event, the
  tool name, the exit code, the duration and, on failure, the reason. A
  listener that throws never affects the hook. With a listener set, the
  hooks a run does not wait for (all but PreToolUse and PostToolUse) run
  attached rather than detached, so their exit can be reported.

### Default Tools

`@plinycode/core` owns the built-in host tools and executors:

- `createBuiltinTools(...)`
- `createDefaultTools(...)`
- `createDefaultExecutors(...)`

### Storage and Settings

The package also exports storage and settings helpers such as:

- `ProviderSettingsManager`
- `CoreSettingsService` and `createCoreSettingsService`
- MCP settings helpers such as `setMcpServerDisabled`
- SQLite-backed local session stores and artifacts through `@plinycode/core`

## Related Packages

- `@plinycode/llms`: provider/model configuration and handlers

## More Examples

- Repo examples: [examples](https://github.com/cline/sdk/tree/main/examples), [apps/examples](https://github.com/cline/sdk/tree/main/apps/examples)
- Workspace overview: [README.md](https://github.com/cline/cline/blob/main/README.md)
- API and architecture references: [DOC.md](https://github.com/cline/cline/blob/main/DOC.md), [ARCHITECTURE.md](https://github.com/cline/cline/blob/main/ARCHITECTURE.md)
