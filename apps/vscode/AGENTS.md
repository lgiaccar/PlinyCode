---
description: Development reference for the PlinyCode VS Code extension (apps/vscode).
globs: "src/**/*.ts,webview-ui/src/**/*.ts,webview-ui/src/**/*.tsx,proto/**/*.proto,scripts/**"
alwaysApply: true
---

# PlinyCode Extension — Development Reference

This is the VS Code / Cursor extension, package `plinycode-dev`. Toolchain, repo layout and naming rules are in the root [AGENTS.md](../../AGENTS.md). The engine it runs on is described in [sdk/AGENTS.md](../../sdk/AGENTS.md). Run the commands below from `apps/vscode` unless noted.

The code was forked from Cline and then moved onto the engine packages, so upstream Cline docs and paths (`src/core/task/index.ts`, `src/core/prompts/system-prompt/`, `ToolExecutor.ts`, snapshot tests) no longer apply here. Many files still say "Replaces classic … (see origin/main)": that refers to upstream, not to a branch in this repo.

## How it fits together

- **Entry:** `src/extension.ts` registers commands and providers, then calls `initialize()` in `src/common.ts`, which sets up `StateManager`, telemetry and the `WebviewProvider`.
- **Controller:** `Controller` (`src/core/controller/index.ts`) is a re-export of `SdkController` in `src/sdk/SdkController.ts`. It delegates the agent loop and session lifecycle to `@plinycode/core`. The `src/sdk/` directory holds the extension side of that bridge: `sdk-*-coordinator.ts` files per concern (task start, messages, MCP, mode, compaction, …), `message-translator.ts` (engine events to `ClineMessage`s) and `webview-grpc-bridge.ts` (pushes them to the webview's streams).
- **Webview:** a React/Vite app in `webview-ui/`. Global state lives in `webview-ui/src/context/ExtensionStateContext.tsx`, fed by the `subscribeToState` stream; its shape is `ExtensionState` in `src/shared/ExtensionMessage.ts`.
- **Host bridge:** `src/hosts/vscode/` holds everything that touches the VS Code API. `hostbridge/<service>/` implements the `proto/host/*.proto` services (diff, env, window, workspace, testing).

## Webview ↔ extension RPC

The webview and the extension talk through protobuf-defined, gRPC-style services carried over VS Code message passing.

To add an RPC:

1. Add it to a service in `proto/cline/<domain>.proto`. Services are `PascalCaseService`, RPCs `camelCase`, messages `PascalCase`. Reuse `common.proto` types for simple values.
2. Run `bun run protos`. It regenerates `src/shared/proto/`, `src/generated/` and `webview-ui/src/services/grpc-client.ts`, all gitignored.
3. Write the handler in **`src/core/controller/<domain>/<rpcName>.ts`**, exporting `async function <rpcName>(controller: Controller, request)`. The generated service table imports it by that exact path. `<domain>` is the service name without `Service`, with its first letter lowercased: `TaskService` → `task/`, `OcaAccountService` → `ocaAccount/`. Server-streaming RPCs also take a `responseStream` argument; see `ui/subscribeToShowWebview.ts`.
4. Call it from the webview through the generated client: `TaskServiceClient.newTask(NewTaskRequest.create({ … }))`.

When you add a value to the `ClineSay` or `ClineAsk` enums, update both the TypeScript union in `src/shared/ExtensionMessage.ts` and the proto enum. The two maps in `src/shared/proto-conversions/cline-message.ts` are exhaustive, so `bun run check-types` points at what's missing. Then render it in `webview-ui/src/components/chat/ChatRow.tsx`.

## State and settings

- Persistent state is declared once, in `src/shared/storage/state-keys.ts`: type, default and metadata. Read and write it through `StateManager` (`src/core/storage/StateManager.ts`: `getGlobalStateKey`, `getGlobalSettingsKey`, `setGlobalState`, `getSecretKey`, …), never through VS Code's `ExtensionContext` storage. Storage is file-backed, and each window caches it in memory from startup, so one window doesn't see another's writes until it restarts.
- Changing `state-keys.ts` regenerates `proto/cline/state.proto`. The pre-commit hook does this automatically. If you need it before committing, run `node scripts/generate-state-proto.mjs` and then `bun run protos`.
- User-facing VS Code settings are declared under `contributes.configuration` in `package.json`. New ones use the `plinycode.*` prefix.

## PlinyCode-specific areas

| Area                                             | Code                                                                                                     | Read first                                                                                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pliny provider, model IDs, featured models       | `src/shared/pliny.ts`, `sdk/packages/llms/src/providers/pliny-models.ts`                                 | —                                                                                                                                                        |
| FreeAuto / BalanceAuto routing and turn guards   | `src/sdk/router/`                                                                                        | [pliny-free-auto-router.md](../../docs/pliny-free-auto-router.md), [pliny-balance-auto.md](../../docs/pliny-balance-auto.md), [pliny-free-auto-thinking.md](../../docs/pliny-free-auto-thinking.md) |
| Built-in DevOps MCP server (GitHub, Azure DevOps) | `src/services/devops-mcp/`, `src/core/controller/mcp/*DevOps*`                                           | [devops-mcp.md](../../docs/devops-mcp.md)                                                                                                               |
| Auto-update from GitHub Releases                 | `src/hosts/vscode/auto-update/`, `scripts/release.ts`                                                    | [releasing.md](../../docs/releasing.md)                                                                                                                  |

## Verifying changes

The engine packages must be built before anything here compiles or tests: run `bun run build:sdk` from the repo root after any change under `sdk/`.

Cheapest first:

| Command                      | What it runs                                                                                          | Time     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | -------- |
| `bun run lint`               | Biome lint and proto lint                                                                             | seconds  |
| `bun run format`             | Biome format check over the whole extension (`bun run fix:all` applies fixes)                         | seconds  |
| `bun run check-types`        | `protos`, then `tsc` for the extension, the VS Code API compatibility check and the webview           | ~1 min   |
| `bun run test:unit`          | every `*.test.ts` that imports from `bun:test`, one `bun` process per file                            | minutes  |
| `bun run test:vitest`        | the vitest suites listed in `vitest.config.ts` (`src/sdk/**` and a few in `src/shared/`)              | minutes  |
| `bun run test:webview`       | the webview's vitest suites                                                                           | minutes  |
| `bun run test:integration`   | tests that import from `mocha`; they need a real VS Code extension host                               | slow     |
| `bun run test:e2e`           | Playwright against a packaged `.vsix` (`src/test/e2e/`)                                               | slowest  |

Which runner picks up a test file depends on how it's written, so check before adding one:

- Importing from `bun:test` is enough for `test:unit` to find the file.
- A vitest test only runs if its path matches `test.include` in `vitest.config.ts`, which is an explicit list; add the path there. The config sets `passWithNoTests`, so a file that matches nothing is silently skipped.
- Use `mocha` only when the test needs the real VS Code API.

To run one file:

```sh
bun test src/shared/combineApiRequests.test.ts                               # bun:test
bunx vitest run --config vitest.config.ts src/shared/pliny.test.ts           # vitest
cd webview-ui && bunx vitest run src/components/settings/utils/plinyModelFilter.test.ts
```

`bun test` preloads `src/test/bun-test-preload.ts` (see `bunfig.toml`), which stubs `vscode` and `@plinycode/core` for unit tests.

## Conventions

- In extension (non-webview) code, log through `Logger` (`src/shared/services/Logger.ts`), not `console`.
- Import `src/utils/path` once to get `String.prototype.toPosix()`, and compare paths with its helpers (`arePathsEqual`, `isLocatedInPath`) so Windows paths work.
- The pre-commit hook runs `gitleaks`, which must be installed, then Biome on staged files.
