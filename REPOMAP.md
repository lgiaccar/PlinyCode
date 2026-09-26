# REPOMAP — PlinyCode Monorepo

Bun 1.3.13 / Node >=22. VS Code extension (`plinycode-dev`) plus internal engine packages (`@plinycode/*`).

This is a directory map. Commands, workflows and rules are in the `AGENTS.md` files: the root [AGENTS.md](AGENTS.md), [apps/vscode/AGENTS.md](apps/vscode/AGENTS.md) and [sdk/AGENTS.md](sdk/AGENTS.md).

## Root

| Dir | Role |
|-----|------|
| `.github/` | PR templates, CODEOWNERS, CI workflows |
| `.vscode/` | Workspace settings, launch configs, tasks |
| `apps/` | Applications (currently the VS Code extension) |
| `sdk/` | Internal engine packages |
| `docs/` | Design and operations docs (releasing, FreeAuto/BalanceAuto routing, DevOps MCP) |
| `assets/` | Shared product icons |
| `patches/` | Bun dependency patches |
| `ai_output/` | Git-ignored scratch dir for ephemeral artifacts |

## Workspaces

Root `package.json` defines workspaces: `sdk/packages/*`, `apps/*`, `apps/vscode/webview-ui`, `apps/vscode/testing-platform`.

> **Important:** Engine packages resolve each other through compiled `dist/`. You **must** run `bun run build:sdk` after any `sdk/packages/` change. Running processes do **not** hot-reload engine source.

## VS Code Extension (`apps/vscode`)

Package `plinycode-dev`. Entry: `src/extension.ts` bundles to `dist/extension.js`.

### `src/` Top-Level

| Path | Role |
|------|------|
| `core/` | RPC handlers (`controller/`), storage, hooks, context and workspace helpers |
| `services/` | VS Code–specific services (auth, telemetry, MCP, browser, search, …) |
| `shared/` | Proto conversions, model catalog, providers, storage, utils |
| `hosts/` | Host abstractions (`external/`, `vscode/`) |
| `integrations/` | Editor integrations (`diagnostics/`, `editor/`, `misc/`, `openai-codex/`, `terminal/`) |
| `sdk/` | The controller (`SdkController.ts`) and the bridge to the engine: per-concern coordinators, message translator, webview gRPC bridge, `router/` (FreeAuto/BalanceAuto), `model-catalog/`, `vscode-lm/` |
| `types/`, `utils/` | Declarations & helpers |
| `exports/`, `standalone/` | Public API & standalone mode |
| `generated/` | Auto-generated protobuf/gRPC code |
| `test/`, `__tests__/` | Extension integration & unit tests |

### `src/core/`

| Path | Role |
|------|------|
| `controller/` | One directory per RPC service, one file per RPC: account, browser, checkpoints, commands, file, gRPC recorder, marketplace, MCP, models, OCA account, remote config, slash commands, state, task, UI, web, worktree. `index.ts` re-exports `Controller` from `src/sdk/SdkController.ts` |
| `task/` | `focus-chain/` and `tools/subagent/`. The agent loop itself runs in `@plinycode/core` |
| `prompts/` | Prompt formatting (`responses.ts`) and tests |
| `context/` | Context tracking (`context-tracking/`, `instructions/`) |
| `storage/` | Persistence (`remote-config/`, `utils/`) |
| `workspace/` | Workspace logic (`utils/`) |
| `api/`, `hooks/`, `locks/`, `mentions/`, `ignore/`, `export/`, `webview/` | Supporting primitives |

### `src/services/`

`account/`, `auth/`, `banner/`, `browser/` (Puppeteer), `devops-mcp/` (built-in DevOps MCP server), `error/`, `feature-flags/`, `glob/`, `lg-cns-integration/`, `logging/`, `mcp/` (`McpHub.ts`), `search/`, `telemetry/`, `temp/`, `uri/`.

### `src/shared/`

`clients/`, `cline/`, `internal/`, `messages/`, `model-catalog/`, `multi-root/`, `proto/`, `proto-conversions/`, `providers/`, `remote-config/`, `services/`, `storage/` (`state-keys.ts`; `StateManager` itself is in `src/core/storage/`), `utils/`.

### `webview-ui/`

React / Vite app for the chat sidebar.

State: `src/context/ExtensionStateContext.tsx`.

`src/components/`, `src/context/`, `src/hooks/`, `src/lib/`, `src/services/`, `src/utils/`, `src/config/`, `src/assets/`, `.storybook/`.

### `proto/`

Protobuf schemas for the gRPC-like protocol over VS Code message passing.

- `proto/cline/` — domain protos (models, tasks, UI, etc.)
- `proto/host/` — host-bridge protos

Run `bun run protos` after any `.proto` edit to regenerate `src/generated/` and the webview grpc client.

## Engine SDK (`sdk/packages/*`)

Not published externally; consumed by the extension through compiled `dist/`.

### `sdk/packages/core`

Agent engine — tasks, sessions, auth, providers, hooks, runtime.

`src/account/`, `src/auth/`, `src/cline-core/`, `src/cron/`, `src/extensions/`, `src/hooks/`, `src/hub/`, `src/logging/`, `src/remote/`, `src/remote-config/`, `src/runtime/`, `src/services/`, `src/session/`, `src/settings/`, `src/tasks/` (`specs/`, `store/`), `src/types/`.

### `sdk/packages/shared`

Shared types & utilities.

`src/agents/`, `src/automation/`, `src/connectors/`, `src/cron/`, `src/db/`, `src/extensions/`, `src/hooks/`, `src/llms/`, `src/logging/`, `src/parse/`, `src/prompt/` (`system/`), `src/providers/`, `src/remote-config/`, `src/rpc/`, `src/runtime/`, `src/services/`, `src/session/`, `src/storage/`, `src/team/`, `src/tools/`, `src/types/`.

### `sdk/packages/llms`

Model catalog and provider gateway.

`src/catalog/`, `src/providers/`, `src/services/`, `src/tests/`.

### `sdk/packages/agents`

Browser-safe agent runtime loop.

`src/agent-runtime.ts`, `src/index.ts`, `*.test.ts`.

### `sdk/packages/ui`

Shared webview theme and components. Source lives at package root rather than under `src/`.

`components/`, `theme/`, `stories/`, `tests/`, `dist/`.

## Key files

| File | Why it matters |
|------|----------------|
| `apps/vscode/src/extension.ts` | Extension activation entry point |
| `apps/vscode/src/sdk/SdkController.ts` | The controller: session lifecycle, delegated to `@plinycode/core` |
| `apps/vscode/src/services/mcp/McpHub.ts` | MCP server hub |
| `apps/vscode/src/shared/storage/state-keys.ts` | Single source of truth for persistent state keys |
| `apps/vscode/src/shared/proto-conversions/` | Proto ↔ TypeScript conversions |
| `sdk/packages/shared/src/prompt/system/` | System prompt definitions and variants |
