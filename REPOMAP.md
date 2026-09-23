# REPOMAP — PlinyCode Monorepo

Bun 1.3.13 / Node >=22. VS Code extension (`plinycode-dev`) plus internal engine packages (`@plinycode/*`).

## Root

| Dir | Role |
|-----|------|
| `.github/` | PR templates, CODEOWNERS, CI workflows |
| `.vscode/` | Workspace settings, launch configs, tasks |
| `.cline/` | Cline workspace rules (auto-generated context) |
| `apps/` | Applications (currently the VS Code extension) |
| `sdk/` | Internal engine packages |
| `docs/` | Design docs (e.g. `pliny-free-auto-router.md`) |
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
| `core/` | Controller, prompts, storage, task execution |
| `services/` | VS Code–specific services (auth, telemetry, MCP, browser, search, …) |
| `shared/` | Proto conversions, model catalog, providers, storage, utils |
| `hosts/` | Host abstractions (`external/`, `vscode/`) |
| `integrations/` | Editor integrations (`diagnostics/`, `editor/`, `misc/`, `openai-codex/`, `terminal/`) |
| `sdk/` | Extension-side wrappers (`model-catalog/`, `router/`, `vscode-lm/`) |
| `types/`, `utils/` | Declarations & helpers |
| `exports/`, `standalone/` | Public API & standalone mode |
| `generated/` | Auto-generated protobuf/gRPC code |
| `test/`, `__tests__/` | Extension integration & unit tests |

### `src/core/` — Agent Engine

| Path | Role |
|------|------|
| `controller/` | **Single source of truth**. Handlers: account, browser, checkpoints, commands, file, gRPC recorder, marketplace, MCP, models, OCA account, remote config, slash commands, state, task, UI, web, worktree |
| `task/` | Agent loop (`focus-chain/`, `tools/`) |
| `prompts/` | Prompt formatting (`responses.ts`) and tests |
| `context/` | Context tracking (`context-tracking/`, `instructions/`) |
| `storage/` | Persistence (`remote-config/`, `utils/`) |
| `workspace/` | Workspace logic (`utils/`) |
| `api/`, `hooks/`, `locks/`, `mentions/`, `ignore/`, `export/`, `webview/` | Supporting primitives |

### `src/services/`

`account/`, `auth/`, `banner/`, `browser/` (Puppeteer), `error/`, `feature-flags/`, `glob/`, `lg-cns-integration/`, `logging/`, `mcp/` (`McpHub.ts`), `search/`, `telemetry/`, `temp/`, `uri/`.

### `src/shared/`

`clients/`, `cline/`, `internal/`, `messages/`, `model-catalog/`, `multi-root/`, `proto/`, `proto-conversions/`, `providers/`, `remote-config/`, `services/`, `storage/` (`state-keys.ts`, `StateManager`), `utils/`.

### `webview-ui/`

React / Vite app for the chat sidebar.

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

## Build, Test & Dev Workflow

| Command | Purpose |
|---------|---------|
| `bun install` | Install all workspace dependencies |
| `bun run build:sdk` | Build engine packages |
| `bun -F plinycode-dev build` | Build extension + webview |
| `bun run compile` / `watch` | Extension compile / watch mode |
| `bun run protos` | Regenerate protobufs after `.proto` edits |
| `bun run types` | Typecheck all packages |
| `bun run test:unit` | Run unit tests |
| `bun run test:e2e` | Engine end-to-end tests |
| `bun run format` / `lint` / `fix` | Biome formatting & linting |

## Key Files & Gotchas

| File | Why it matters |
|------|----------------|
| `src/extension.ts` | Extension activation entry point |
| `src/core/controller/index.ts` | Central controller hub |
| `src/services/mcp/McpHub.ts` | MCP server hub |
| `src/shared/storage/state-keys.ts` | Typed global state keys |
| `src/shared/proto-conversions/` | Bidirectional proto ↔ TS conversions |
| `sdk/packages/shared/src/prompt/system/` | System prompt definitions and variants |

1. `build:sdk` is required after any `sdk/packages/` edit — imports will fail otherwise.
2. `bun run protos` is required immediately after any `.proto` edit.
3. Adding an API provider requires coordinated updates across `proto/`, `proto-conversions/`, `shared/api.ts`, and `webview-ui/.../ApiOptions.tsx`; missing any silently resets the provider to Anthropic.
4. Adding a global state key requires updating `state-keys.ts` and using `StateManager` rather than raw VS Code `ExtensionContext` storage.
5. System prompt changes require regenerating snapshots: `UPDATE_SNAPSHOTS=true bun run test:unit`.

