This is the **PlinyCode** monorepo. Toolchain is **Bun 1.3.14** (package manager + task runner) with **Node >=22** as the runtime, both pinned in `.tool-versions` (the file CI reads; `package.json`'s `packageManager` and `engines.bun` mirror the Bun version). Do not use npm/yarn/pnpm.

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
- [docs/pliny-free-auto-router.md](docs/pliny-free-auto-router.md), [docs/pliny-free-auto-thinking.md](docs/pliny-free-auto-thinking.md) and [docs/pliny-balance-auto.md](docs/pliny-balance-auto.md): how the FreeAuto and BalanceAuto models route, keep runs going, and hand images to models that cannot see them (`plinycode.router.images`).
- [docs/router-settings.md](docs/router-settings.md): Settings → Router, which sets each router's model order (for example GLM-5.2 before Kimi K2.6), sets its compaction budget and post-compaction size (tokens or percent, with notes on which models hand off), and overrides every rules-file knob, stored in `routerTuning` and laid over the rules files on every call.
- [docs/pliny-api-keys.md](docs/pliny-api-keys.md): Pliny API keys added in Settings (named, stored in the OS keychain, one active), the order keys are taken in (Settings, then `providers.json`, then `PLINY_API_KEY`), and the offer to switch keys when the gateway rejects one or its budget runs out.
- [docs/devops-mcp.md](docs/devops-mcp.md): the built-in DevOps MCP server for GitHub and Azure DevOps.
- [docs/plan-mode.md](docs/plan-mode.md): how plan mode writes markdown plan files (`<dataDir>/plans/<workspace>/<slug>/PLAN.md`, outside the workspace), the **Open Plan…** command, the markdown-only write guard, the Execute plan button, and why switching to Agent mode alone does not run the plan.
- [docs/ask-mode.md](docs/ask-mode.md): ask mode, the third mode next to Plan and Agent (the act mode), which answers questions and blocks every file edit.
- [docs/side-questions.md](docs/side-questions.md): side questions, messages asked off the record: answered read-only and left out of later requests.
- [docs/model-tuning.md](docs/model-tuning.md): the model tuning button (thinking, effort and context size per model, stored in `modelTuning`), which controls each model is offered and why, how a tuning reaches the session, and the hosted-model thinking probe.
- [docs/improve-prompt.md](docs/improve-prompt.md): the Improve prompt button, which has a small free model rewrite the draft for grammar and clarity, with Undo.
- [docs/diagnostics-bundle.md](docs/diagnostics-bundle.md): the diagnostics bundle (PlinyCode: Export Diagnostics Bundle): the folder it writes under `<dataDir>/diagnostics/`, what each file holds, what is redacted and how to share it.
- [docs/restart-from-here.md](docs/restart-from-here.md): editing an earlier message and restarting from it, how the chat row is mapped to the history the model sees, which checkpoint "Restart and revert files" uses, and the Show Last Model Request debug command.
- [docs/conversation-history.md](docs/conversation-history.md): the history view's filters (favorites, search, date), pinned conversations, and how the favorite and pin flags are stored.
- [docs/workspace-conversations.md](docs/workspace-conversations.md): how conversations are bound to workspaces (folders and `.code-workspace` files), filtered by workspace, started in another workspace and shared between windows.
- [docs/task-worktrees.md](docs/task-worktrees.md): **Run in worktree**, which starts a conversation on a new branch in a git worktree of its own (where it goes, `plinycode.worktrees.root`, the task header chip), bringing the work back (Apply, Create PR, Remove worktree), and the daily cleanup of PlinyCode worktrees (`plinycode.worktrees.keepDays`, **Manage Worktrees**).
- [docs/agent-tools.md](docs/agent-tools.md): how the editing, search, file-finding, web search and `view_image` tools behave (including the `web_search` backends and settings), how `run_commands` handles long-running commands and narrow terminals, the background processes it leaves running (`process_list`, `process_output`, `process_kill`), which tools run concurrently, and the `update_todo_list` task list.
- [docs/edit-problems.md](docs/edit-problems.md): how edit results list the new errors VS Code reports for the edited files, and the `plinycode.edits.reportNewProblems` setting.
- [docs/environment-context.md](docs/environment-context.md): the git snapshot in the system prompt (taken once per conversation) and the editor state sent with each user message, and how both stay out of the chat.
- [docs/memory.md](docs/memory.md): repo memory: the per-repository and per-user `MEMORY.md` files loaded into the system prompt within `plinycode.memory.maxTokens`, `save_memory` and `/remember`, distillation proposals, and the past-conversation search tools.
- [docs/prompt-cache.md](docs/prompt-cache.md): which Pliny models are prompt-cached, where the cache breakpoints go and why, the live-gateway probe that measures it, and the task header's per-call token usage panel.
- [docs/advisor-tool.md](docs/advisor-tool.md): the `ask_advisor` tool, which lets a free or cheap model ask a stronger one for advice at a hard step, and how its cost is recorded and budget-checked.
- [docs/review-pass.md](docs/review-pass.md): the reviewer pass, in which a second free model reads the diff before a FreeAuto or BalanceAuto act-mode run ends and hands likely defects back once.
- The CI watcher (`watch_ci`), which wakes a conversation when CI finishes, is described in [docs/devops-mcp.md](docs/devops-mcp.md).
- [docs/ci-board.md](docs/ci-board.md): the CI Board, which watches many pull requests and branches with one status per pipeline, has a free model triage their failures (severity, summary, markdown reports), runs fixes (actions) against them in git worktrees on the free auto-router, and with auto-watch fixes conflicts and small test deltas by itself under its own approval rules.
- [docs/context-management-audit.md](docs/context-management-audit.md): the audit of sub-agents, task isolation, context compression, memory and knowledge, with each finding's site and the wave that fixes it.
- [docs/rules.md](docs/rules.md): which rules files reach the model (including `AGENTS.md` and `CLAUDE.md` files below the root, listed by path and scope), the rules budget and the order rules are inlined in; also hook files: which events the engine runs them for, the per-file toggles in the Hooks tab, and the `hook_status` chat rows.
- [docs/context-compaction.md](docs/context-compaction.md): when the conversation is compacted, the agentic and basic strategies and the fallback between them, overflow recovery, what the summarizer costs, the per-model calibrated token estimate (also used by the router's size filter), how a compaction shows in the chat (divider, summary, rebuilt on reopen) without reaching the model, and the context bar: its breakdown by source (tools, memory, skills, workflows …), its click-to-set threshold (`plinycode.compaction.threshold`) and why it can drop without a compaction.
- [docs/pipeline-runs.md](docs/pipeline-runs.md): the Pipelines view, dynamic GitHub/ADO inputs, queueing, persistent launch history and run-ID tracking.
- [docs/eval-harness.md](docs/eval-harness.md): the eval harness in `sdk/scripts/eval`: cases (a fixture, a prompt, a model and assertions) run as headless engine sessions, replayed offline from VCR cassettes in CI (`eval-offline`) or recorded against the live gateway with `--record`, and how to add a case.
- [docs/roadmap.md](docs/roadmap.md): the Q4 2026 improvement roadmap: six two-week waves (code intelligence, worktrees, background processes, sub-agent visibility, web search and images, eval harness, trace and diagnostics, hook unification, release automation), each with PR-sized items, file anchors and verification.
- [docs/trace-and-logs.md](docs/trace-and-logs.md): the per-conversation trace files (`traces/<session id>.jsonl`: requests, replies, tool calls, routing decisions, run failures), their record types, redaction and size caps, the `plinycode.trace.enabled` setting, and the rotating `logs/plinycode.log` file with its Open Log File command.

Write scratch output (logs, analysis, temporary files) to `ai_output/`, which is gitignored, rather than to the repo tree.

## Build / lint / test

- Engine packages (`@plinycode/shared|llms|agents|core`) resolve each other through compiled `dist/` (their `exports` point only at `dist/`, with no `development` source condition). You **must** run `bun run build:sdk` after changing engine source before running the extension or its tests, otherwise imports fail with missing `@plinycode/*` / missing `dist/` errors. `bun run watch:sdk` (`sdk/scripts/watch-sdk.ts`) does this for you while you work: it rebuilds a changed package and its dependents in dependency order (`shared` → `llms` → `core`, each with its own `build` script, so `core`'s declaration build takes a while), ignores test files, and is part of the default `watch` task in `.vscode/tasks.json`; pass `--initial` to build everything first when `dist/` is missing. Running processes do **not** hot-reload engine source changes — rebuild and restart.
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

PRs target the `stage` branch, not `master`. Every workflow in `.github/workflows/` runs on PRs and on each push to `stage` and `master`, so a merge that breaks something is caught after it lands too:

| Workflow          | Runs when the PR changes                                  | On a push to `stage`/`master`                       | What it checks                                                                   |
| ----------------- | --------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `docs-check`      | anything                                                  | always                                              | markdown links and skill frontmatter (`bun run check:docs`); takes seconds       |
| `engine-test`     | `sdk/**`, `bun.lock`, its own workflow file, `.github/actions/**` | same path filter (no run at all otherwise)  | engine build (once, in `Quality Checks`), `bun run types`, lint and format, engine tests on Ubuntu (Node 22 and 24) and Windows (Node 22), offline eval cases (`eval-offline`) |
| `ext-vscode-test` | extension source, config or tests, `sdk/packages/**`, `bun.lock`, `.github/actions/**` | all jobs                | engine build (once, in `Quality Checks`), extension type check, lint and format; unit, vitest, integration and webview tests on Ubuntu and Windows |
| `ext-vscode-test-e2e` | the same kinds of paths as `ext-vscode-test`          | all jobs                                            | Playwright e2e on Ubuntu, Windows and macOS; on a PR, the Ubuntu leg attaches the packaged extension to the run as `PlinyCode-<version>-pr<number>.vsix` |

A path filter can skip a workflow's heavy jobs while it still reports success, so check which jobs actually ran. A docs-only PR, for example, runs only `docs-check`. A new push to a PR cancels that PR's running checks; pushes to `stage` and `master` never cancel each other.

Every job installs its tools through the composite action `.github/actions/setup-toolchain`, which reads the Bun and Node pins from `.tool-versions`, caches `~/.bun/install/cache` by `bun.lock` hash and runs `bun install --frozen-lockfile` at the root (`install: "false"` skips the install, `node-version` overrides the Node pin for matrix jobs). Change a toolchain version in `.tool-versions` and mirror the Bun one in `package.json`.

The engine is built once per run where a job already runs ahead of the others: in `engine-test` and `ext-vscode-test`, `Quality Checks` runs `bun run build:sdk` and shares `sdk/packages/*/dist` through the composite action `.github/actions/sdk-dist` (`mode: upload`), and the jobs that wait for it (the engine test legs, `eval-offline`, both `vscode test` legs) restore it with `mode: download` instead of rebuilding, on Windows too. `dist/` is plain JavaScript and `.d.ts`, and `.gitattributes` checks everything out with LF endings, so an Ubuntu build is what Windows would build. Each e2e leg still builds its own: the build takes 10-20 s, and a separate job in front of the legs would cost more than that. Testers can install a PR's build without a pre-release: see [docs/releasing.md](docs/releasing.md#installing-a-pull-requests-build).

Dependabot (`.github/dependabot.yml`) opens security-only PRs for the Bun workspace (root `bun.lock`) and for the GitHub Actions the workflows use.

## Naming

The product is **PlinyCode**. Use that name in anything a user can see — UI strings, settings descriptions, docs and commit messages. New user-facing settings use the `plinycode.*` prefix.

Some internal identifiers intentionally keep the `cline` prefix, because renaming them would break existing installs and the wire protocol:

- the `cline.*` VS Code command IDs and context keys
- the `cline` protobuf package namespace (and the `@cline-grpc/*` path alias)
- the `.clinerules` workspace files
- the `Documents/Cline` on-disk paths

`.clineignore` files are not read: nothing in the extension or the engine enforces them. Old conversations that show a `clineignore_error` still render.
