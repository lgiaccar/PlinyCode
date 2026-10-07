This is the **PlinyCode** monorepo. Toolchain is **Bun 1.3.13** (package manager + task runner) with **Node >=22** as the runtime. Do not use npm/yarn/pnpm.

PlinyCode is a VS Code / Cursor extension that talks only to Synopsys internal models through the Pliny gateway.

## Layout

| Path                  | Contents                                                        |
| --------------------- | --------------------------------------------------------------- |
| `apps/vscode`         | The VS Code extension (`plinycode-dev`) and its webview UI     |
| `sdk/packages/core`   | Agent engine — tasks, sessions, auth, providers, hooks, runtime |
| `sdk/packages/shared` | Shared types and utilities                                      |
| `sdk/packages/llms`   | Model catalog and provider gateway                              |

Despite living under `sdk/`, these packages are **not** a distributable SDK — they are the engine the extension runs on. Over 100 files in `apps/vscode/src` import them.

## Where to look next

This file covers the whole repo. Read the guide nearest to the code you're changing as well:

- [apps/vscode/AGENTS.md](apps/vscode/AGENTS.md): how the extension is put together (controller, webview RPC, state), where PlinyCode's own features live, and which test runner covers what.
- [sdk/AGENTS.md](sdk/AGENTS.md): engine package boundaries, dependency direction, and which package owns a change.
- [sdk/packages/llms/AGENTS.md](sdk/packages/llms/AGENTS.md): provider and model routing rules.
- [REPOMAP.md](REPOMAP.md): a directory-by-directory map of the repo.
- Claude Code skills in `.claude/skills/`: `/release` cuts an official release, and `/prerelease` ticks the `-test.N` version on a PR branch and can publish it as a pre-release.

Design and operations notes are in `docs/`:

- [docs/releasing.md](docs/releasing.md): releases, `-test.N` pre-releases and the auto-updater. Read it before any version or release work.
- [docs/pliny-free-auto-router.md](docs/pliny-free-auto-router.md), [docs/pliny-free-auto-thinking.md](docs/pliny-free-auto-thinking.md) and [docs/pliny-balance-auto.md](docs/pliny-balance-auto.md): how the FreeAuto and BalanceAuto models route and keep runs going.
- [docs/devops-mcp.md](docs/devops-mcp.md): the built-in DevOps MCP server for GitHub and Azure DevOps.
- [docs/plan-mode.md](docs/plan-mode.md): how plan mode writes markdown plan files (`plans/<slug>/PLAN.md`), the markdown-only write guard, and the Execute plan button.
- [docs/ask-mode.md](docs/ask-mode.md): ask mode, the third mode next to Plan and Agent (the act mode), which answers questions and blocks every file edit.
- [docs/side-questions.md](docs/side-questions.md): side questions, messages asked off the record: answered read-only and left out of later requests.
- [docs/conversation-history.md](docs/conversation-history.md): the history view's filters (favorites, search, date), pinned conversations, and how the favorite and pin flags are stored.
- [docs/workspace-conversations.md](docs/workspace-conversations.md): how conversations are bound to workspaces (folders and `.code-workspace` files), filtered by workspace, started in another workspace and shared between windows.
- [docs/agent-tools.md](docs/agent-tools.md): how the editing, search and file-finding tools behave, how `run_commands` handles long-running commands and narrow terminals, which tools run concurrently, and the `update_todo_list` task list.
- [docs/edit-problems.md](docs/edit-problems.md): how edit results list the new errors VS Code reports for the edited files, and the `plinycode.edits.reportNewProblems` setting.
- [docs/environment-context.md](docs/environment-context.md): the git snapshot in the system prompt (taken once per conversation) and the editor state sent with each user message, and how both stay out of the chat.
- [docs/advisor-tool.md](docs/advisor-tool.md): the `ask_advisor` tool, which lets a free or cheap model ask a stronger one for advice at a hard step, and how its cost is recorded and budget-checked.
- [docs/review-pass.md](docs/review-pass.md): the reviewer pass, in which a second free model reads the diff before a FreeAuto or BalanceAuto act-mode run ends and hands likely defects back once.
- The CI watcher (`watch_ci`), which wakes a conversation when CI finishes, is described in [docs/devops-mcp.md](docs/devops-mcp.md).
- [docs/ci-board.md](docs/ci-board.md): the CI Board, which watches many pull requests and branches with one status per pipeline, and runs prompts (actions) against them in git worktrees.

Write scratch output (logs, analysis, temporary files) to `ai_output/`, which is gitignored, rather than to the repo tree.

## Build / lint / test

- Engine packages (`@plinycode/shared|llms|agents|core`) resolve each other through compiled `dist/` (their `exports` point only at `dist/`, with no `development` source condition). You **must** run `bun run build:sdk` after changing engine source before running the extension or its tests, otherwise imports fail with missing `@plinycode/*` / missing `dist/` errors. Running processes do **not** hot-reload engine source changes — rebuild and restart.
- `bun run types` typechecks every package, including the extension (its `typecheck` script runs `check-types`, which regenerates the protobuf code first).
- `bun run lint` runs Biome's linter, `bun run format` checks formatting and import order, and `bun run fix` applies Biome's fixes. Each covers `sdk/` and the extension, which has its own Biome config. `bun run check` runs lint, format, both builds and `types` in one go, like CI's quality checks. `bun run check:docs` checks that relative links in every tracked markdown file resolve, and that every skill in `.claude/skills/` has a valid `name` and `description`.
- `bun -F plinycode-dev analyze:unused:prod` runs knip and lists the files, exports and dependencies that the shipped extension and webview don't use; tests don't count as users. CI's Quality Checks job runs it as a blocking check and writes the report to its summary; a genuine false positive (something knip can't see is really used, e.g. a webview `@shared` import or a Storybook-only file) goes in `apps/vscode/knip.json`'s `ignore`/`ignoreDependencies` lists with a comment explaining why, rather than being worked around elsewhere. `bun run metrics` prints source and test lines per package and the files over 800 lines; CI's Quality Checks job writes it to its summary without failing on it.
- `bun -F plinycode-dev test:unit` runs the bun-based extension unit suite (no VS Code host needed). `bun run test` runs the engine suites plus the extension's `test` script, which also runs the VS Code integration tests, so it needs a desktop session (on Linux, `xvfb-run`).
- Some engine tests need `bash`, `bun` and network access on PATH; they fail in environments lacking those, which is an environment artifact rather than a code bug.

## VS Code extension (`apps/vscode`, package `plinycode-dev`)

- **Codegen prerequisite:** `bun run protos` (from `apps/vscode`) regenerates `src/generated/*` and the webview grpc client. The `dev`, `build:webview`, and `check-types` scripts already run it, so proto changes are picked up by those commands; run it manually only if you edit `.proto` files without a full build. `src/generated/` is gitignored, so a stale local copy can produce type errors that CI does not see.
- **Build:** `bun run build:webview` (webview UI) then `bun esbuild.mjs` (extension bundle). `bun run package` does the full production build.
- **Run it (dev host):** `code --extensionDevelopmentPath=./apps/vscode <some-folder>`, then click the PlinyCode icon in the Activity Bar. On Linux containers add `--no-sandbox`.
- **Test:** `bun run test:unit` (bun-based, no VS Code host). `bun run test:integration` (`@vscode/test-electron`) and `bun run test:e2e` (Playwright) exercise a real extension host and are heavier. [apps/vscode/AGENTS.md](apps/vscode/AGENTS.md) lists every runner and how to run a single file.

## Pull requests and CI

PRs target the `stage` branch, not `master`. Each workflow in `.github/workflows/` runs on PRs as follows:

| Workflow          | Runs when the PR changes                                  | What it checks                                                                   |
| ----------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `docs-check`      | anything                                                  | markdown links and skill frontmatter (`bun run check:docs`); takes seconds       |
| `engine-test`     | `sdk/**`                                                  | engine build, `bun run types`, lint and format, engine tests on Ubuntu and Windows |
| `ext-vscode-test` | extension source, config or tests, `sdk/packages/**`, `bun.lock` | extension type check, lint and format; unit, vitest, integration and webview tests on Ubuntu and Windows |
| `ext-vscode-test-e2e` | the same kinds of paths as `ext-vscode-test`          | Playwright e2e on Ubuntu, Windows and macOS                                      |

A path filter can skip a workflow's heavy jobs while it still reports success, so check which jobs actually ran. A docs-only PR, for example, runs only `docs-check`.

## Naming

The product is **PlinyCode**. Use that name in anything a user can see — UI strings, settings descriptions, docs and commit messages. New user-facing settings use the `plinycode.*` prefix.

Some internal identifiers intentionally keep the `cline` prefix, because renaming them would break existing installs and the wire protocol:

- the `cline.*` VS Code command IDs and context keys
- the `cline` protobuf package namespace (and the `@cline-grpc/*` path alias)
- the `.clinerules` workspace files
- the `Documents/Cline` on-disk paths

`.clineignore` files are not read: nothing in the extension or the engine enforces them. Old conversations that show a `clineignore_error` still render.
