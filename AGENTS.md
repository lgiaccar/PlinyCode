This is the **PlinyCode** monorepo. Toolchain is **Bun 1.3.13** (package manager + task runner) with **Node >=22** as the runtime. Do not use npm/yarn/pnpm.

PlinyCode is a VS Code / Cursor extension that talks only to Synopsys internal models through the Pliny gateway (`https://snps-inference.internal.synopsys.com`).

## Layout

| Path                  | Contents                                                        |
| --------------------- | --------------------------------------------------------------- |
| `apps/vscode`         | The VS Code extension (`plinycode-dev`) and its webview UI     |
| `sdk/packages/core`   | Agent engine — tasks, sessions, auth, providers, hooks, runtime |
| `sdk/packages/shared` | Shared types and utilities                                      |
| `sdk/packages/llms`   | Model catalog and provider gateway                              |
| `sdk/packages/agents` | Browser-safe agent runtime loop                                 |
| `sdk/packages/ui`     | Shared webview theme and components                             |

Despite living under `sdk/`, these packages are **not** a distributable SDK — they are the engine the extension runs on. Over 100 files in `apps/vscode/src` import them.

## Where to look next

This file covers the whole repo. Read the guide nearest to the code you're changing as well:

- [apps/vscode/AGENTS.md](apps/vscode/AGENTS.md): how the extension is put together (controller, webview RPC, state), where PlinyCode's own features live, and which test runner covers what.
- [sdk/AGENTS.md](sdk/AGENTS.md): engine package boundaries, dependency direction, and which package owns a change.
- [sdk/packages/llms/AGENTS.md](sdk/packages/llms/AGENTS.md): provider and model routing rules.
- [REPOMAP.md](REPOMAP.md): a directory-by-directory map of the repo.

Design and operations notes are in `docs/`:

- [docs/releasing.md](docs/releasing.md): releases, `-test.N` pre-releases and the auto-updater. Read it before any version or release work.
- [docs/pliny-free-auto-router.md](docs/pliny-free-auto-router.md), [docs/pliny-free-auto-thinking.md](docs/pliny-free-auto-thinking.md) and [docs/pliny-balance-auto.md](docs/pliny-balance-auto.md): how the FreeAuto and BalanceAuto models route and keep runs going.
- [docs/devops-mcp.md](docs/devops-mcp.md): the built-in DevOps MCP server for GitHub and Azure DevOps.

Write scratch output (logs, analysis, temporary files) to `ai_output/`, which is gitignored, rather than to the repo tree.

## Build / lint / test

- Engine packages (`@plinycode/shared|llms|agents|core`) resolve each other through compiled `dist/` (their `exports` point only at `dist/`, with no `development` source condition). You **must** run `bun run build:sdk` after changing engine source before running the extension or its tests, otherwise imports fail with missing `@plinycode/*` / missing `dist/` errors. Running processes do **not** hot-reload engine source changes — rebuild and restart.
- `bun run types` typechecks the **engine packages only**. The extension has no `typecheck` script, so it is not included: typecheck it with `cd apps/vscode && bun run check-types`.
- `bun run lint` and `bun run format` run Biome. `bun run check:docs` checks that relative links in every tracked markdown file resolve.
- `bun -F plinycode-dev test:unit` runs the bun-based extension unit suite (no VS Code host needed). `bun run test` runs the engine suites plus the extension's `test` script, which also runs the VS Code integration tests, so it needs a desktop session (on Linux, `xvfb-run`).
- Some engine tests need `bash`, `bun` and network access on PATH; they fail in environments lacking those, which is an environment artifact rather than a code bug.
- Two tests in `sdk/packages/core/src/hub/server/index.test.ts` fail with `HubLockHeldError` while a PlinyCode editor is running on the same machine, because it holds the shared hub lock. That's environmental too: close the editor, or ignore those two.

## VS Code extension (`apps/vscode`, package `plinycode-dev`)

- **Codegen prerequisite:** `bun run protos` (from `apps/vscode`) regenerates `src/generated/*` and the webview grpc client. The `dev`, `build:webview`, and `check-types` scripts already run it, so proto changes are picked up by those commands; run it manually only if you edit `.proto` files without a full build. `src/generated/` is gitignored, so a stale local copy can produce type errors that CI does not see.
- **Build:** `bun run build:webview` (webview UI) then `bun esbuild.mjs` (extension bundle). `bun run package` does the full production build.
- **Run it (dev host):** `code --extensionDevelopmentPath=./apps/vscode <some-folder>`, then click the PlinyCode icon in the Activity Bar. On Linux containers add `--no-sandbox`.
- **Test:** `bun run test:unit` (bun-based, no VS Code host). `bun run test:integration` (`@vscode/test-electron`) and `bun run test:e2e` (Playwright) exercise a real extension host and are heavier. [apps/vscode/AGENTS.md](apps/vscode/AGENTS.md) lists every runner and how to run a single file.

## Pull requests and CI

PRs target the `stage` branch, not `master`. Each workflow in `.github/workflows/` runs on PRs as follows:

| Workflow          | Runs when the PR changes                                  | What it checks                                                                   |
| ----------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `docs-check`      | anything                                                  | relative links in markdown (`bun run check:docs`); takes seconds                 |
| `engine-test`     | `sdk/**`                                                  | engine build, `bun run types`, lint, engine tests on Ubuntu and Windows          |
| `ext-vscode-test` | extension source, config or tests, `sdk/packages/**`, `bun.lock` | extension type check, lint and format; unit, vitest, integration and webview tests on Ubuntu and Windows; testing-platform specs |
| `ext-vscode-test-e2e` | the same kinds of paths as `ext-vscode-test`          | Playwright e2e on Ubuntu, Windows and macOS                                      |

A path filter can skip a workflow's heavy jobs while it still reports success, so check which jobs actually ran. A docs-only PR, for example, runs only `docs-check`.

## Naming

The product is **PlinyCode**. Use that name in anything a user can see — UI strings, settings descriptions, docs and commit messages. New user-facing settings use the `plinycode.*` prefix.

Some internal identifiers intentionally keep the `cline` prefix, because renaming them would break existing installs and the wire protocol:

- the `cline.*` VS Code command IDs and context keys
- the `cline` protobuf package namespace (and the `@cline-grpc/*` path alias)
- the `.clinerules` and `.clineignore` workspace files
- the `Documents/Cline` on-disk paths
