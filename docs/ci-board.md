# CI Board

The CI Board watches many pull requests and branches at once, on **GitHub** (Actions) and **Azure DevOps**
(Pipelines, cloud or on-premises). Each pull request shows one colored dot per pipeline and a badge when it
conflicts with its target branch. An **action** runs a prompt against a pull request: it opens a conversation in
a git worktree of the branch, where the agent fixes conflicts, investigates failures, fixes the build and pushes.

`watch_ci` ([devops-mcp.md](devops-mcp.md#watching-ci-watch_ci)) watches one pull request for one conversation.
The board is for the overview, and for starting that work.

Open it with the pulse icon in the PlinyCode panel's title bar.

## What to watch

| You add                                   | The board shows                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| A pull request link                       | That pull request.                                                                 |
| A branch of a repository open in the window | The branch's open pull request, or the branch's pushed head when it has none.      |
| **My open PRs** / **All** for a repository | The repository's open pull requests (yours, or everyone's), most recently updated first, up to `plinycode.ci.board.maxPrsPerRepo`. |

A link can be GitHub's `…/owner/repo/pull/12` (including GitHub Enterprise hosts) or Azure DevOps'
`…/_git/repo/pullrequest/12`, cloud or on-premises (`https://host/tfs/Collection/Project/_git/repo/pullrequest/12`).
The board signs in like the DevOps server does ([devops-mcp.md](devops-mcp.md#sign-in)), but never shows a
sign-in prompt, since it polls in the background. Azure DevOps Server needs `AZURE_DEVOPS_PAT`; a target that
cannot sign in shows the error under its name.

The board belongs to the window's workspace: each window shows, polls and notifies about its own. It is saved in
`ci-board.json` in PlinyCode's data directory and survives reloads.

## Reading it

Each dot is a workflow (GitHub) or pipeline definition (Azure DevOps) on the pull request's head commit. If a
pipeline ran more than once on that commit, the newest run sets the color:

| Color  | Meaning                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------- |
| Green  | Passed.                                                                                                   |
| Red    | Failed or partially succeeded.                                                                            |
| Yellow | Queued or running.                                                                                        |
| Grey   | Cancelled or skipped, or no run on this commit for a pipeline that ran on an earlier one: a new push whose runs have not started, a pipeline whose path filter skipped it, or an Azure DevOps PR build that never queued because the PR conflicts. |

Click a dot to open its run. **Conflicts** means the pull request does not merge cleanly into its target branch;
**Checking merge…** means GitHub or Azure DevOps is still working that out.

## Actions

Every entry starts with one action, **Fix CI & conflicts**, which runs the built-in prompt. The gear button edits
an entry's actions. Each action has a name and a prompt:

- **Built-in.** Sync the branch, merge the target branch and resolve conflicts (keeping both sides' intent, never
  hand-merging generated or data files), triage the failed runs with `pr_checks`, `pipeline_runs` and
  `pipeline_report`, fix the build, fix or update tests the way the repository documents (never recalibrating a
  regression), push, call `watch_ci`, and report.
- **Prompt file.** A Markdown or text file. A relative path is looked up in the branch's worktree first, then in
  the repository, so a prompt checked into the repository (for example
  `AI_prompts/pipelines_failures_investigation.md`) follows the branch. YAML front matter is dropped.
- **Prompt text.** Typed into the editor.

Prompts can use `{{prId}}`, `{{prUrl}}`, `{{sourceBranch}}`, `{{targetBranch}}`, `{{headSha}}`, `{{remote}}` and
`{{worktree}}`. Before the prompt, the board adds a header with the pull request, its head commit, its merge
state, every pipeline with its run id, and the working copy. It also tells the agent to pass
`workspace: "<worktree>"` to the DevOps tools.

**Run** (or the action's name) starts the action:

1. If the conversation it last started for this pull request is still running, the board opens it instead.
2. The board gets a working copy of the branch (see [Worktrees](#worktrees)).
3. It switches to Agent mode if Plan or Ask mode is on, since an action edits and pushes.
4. It starts a conversation in that working copy and shows it. If a task is already running and the background
   holds as many tasks as it can, the board asks first, because starting one stops the running task.

The row then links the conversation (**Conversation**, **Running**, or **Running in background**, with an eye
icon while `watch_ci` is watching it). Edits, commands and pushes follow your usual auto-approve settings.

An action cannot run on a pull request from a fork (its branch cannot be pushed to from here), on a merged or
closed pull request, or when no folder in the window is a checkout of the repository. The Run button's tooltip
says which. A checkout matches whatever case its remote URL uses, and for Azure DevOps Server whatever host name
(old or new) it uses, as long as the collection, project and repository are the same.

## Worktrees

A pull request whose branch is checked out in the window's repository runs right there, beside any changes you
have open. Any other branch gets a git worktree, so several pull requests can be worked on at once without
touching your checkout:

- It goes in `<repository>.worktrees/<branch>` next to the repository, or under `plinycode.ci.worktreeRoot`.
  Branch names are shortened and given a hash where needed, for Windows path limits.
- The board fetches the branch first. An existing worktree of the branch is reused and fast-forwarded when it is
  clean; with local changes or local commits it is left alone, and the agent is told so.
- Submodules are checked out when the repository has them.
- Worktrees stay after the run. Remove them with `git worktree remove` when you are done. A worktree is a full
  working copy, so a C++ repository needs a full build in each one.

Conversations started in a worktree are bound to it ([workspace-conversations.md](workspace-conversations.md)), so
they appear in History under **All workspaces**, or from the board's conversation link. Worktrees are not added
to the recently used workspaces.

## Autonomy

Each entry has an autonomy setting:

| Setting    | When CI fails or the PR conflicts                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| Manual     | A notification, with **Open CI Board** and a button that runs the entry's first action.             |
| Auto       | Coming: starts the action whose trigger matches, in the background, with the usual approvals.      |
| Full auto  | Coming: also approves the action's tool calls, with a cap on attempts and cost per pull request.   |

An action's **Runs automatically** trigger (on failure, on conflict, or both) is what Auto and Full auto will use.
Notifications come once per failure: a pipeline that stays red on the same commit is not reported again, and
nothing is reported for what was already red when the board started.

## Polling and rate limits

The board checks every `plinycode.ci.board.pollSeconds` (60) while it is on screen and every
`plinycode.ci.board.hiddenPollSeconds` (180) otherwise, so notifications keep working. Each check lists each
entry's pull requests, but asks for a pull request's runs only when something can have changed:

- its head commit moved;
- a run is still going;
- its merge state is still being computed;
- or 10 minutes have passed (this catches re-runs).

On GitHub, unchanged answers come back as `304 Not Modified`, which does not count against the rate limit. An
idle repository with 20 open pull requests costs about 60 listing requests an hour, plus each pull request's runs
every 10 minutes. When fewer than 500 GitHub requests are left, the board checks four times less often and only
looks at new commits until the limit resets; a note at the top says so.

## Settings

| Setting                               | Default | What it does                                                    |
| ------------------------------------- | ------- | --------------------------------------------------------------- |
| `plinycode.ci.board.pollSeconds`      | `60`    | Seconds between checks while the board is on screen (min. 30).  |
| `plinycode.ci.board.hiddenPollSeconds` | `180`  | Seconds between checks while it is not (min. 30).               |
| `plinycode.ci.board.notify`           | `true`  | Notify when a pipeline fails or a pull request conflicts.       |
| `plinycode.ci.board.maxPrsPerRepo`    | `30`    | Most open pull requests listed per repository.                  |
| `plinycode.ci.worktreeRoot`           | `""`    | Folder for the board's worktrees; empty means next to the repository. |

## For developers

| Path                                                          | Contents                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/vscode/src/services/devops-mcp/ci-board/`               | The board, no `vscode` import: targets and store (`ci-board.ts`, `ci-board-store.ts`), polling (`ci-board-poller.ts`), dots and transitions (`ci-board-snapshot.ts`), PR links, worktrees, prompts and the built-in prompt. |
| `apps/vscode/src/services/devops-mcp/host/CiBoardHost.ts`     | Builds the window's board with the editor's sign-in, finds checkouts among the window's folders, turns transitions into notifications. |
| `apps/vscode/src/services/devops-mcp/server/providers/`       | `listOpenPrs`, `branchHead`, merge state, forks and pipeline names, added for the board; GitHub ETag revalidation. |
| `apps/vscode/proto/cline/ci_board.proto`, `src/core/controller/ciBoard/` | The webview's `CiBoardService` and its handlers; `start-ci-run.ts` starts an action.   |
| `apps/vscode/webview-ui/src/components/ciBoard/`              | The view.                                                                                    |

A conversation in a worktree runs the DevOps tools against the worktree: `BuiltinMcpSource.providerFor(cwd)`
fills in `workspace` for calls that leave it out, where the server would otherwise use the window's first folder.

Tests: `bun test src/services/devops-mcp` (needs `git` on `PATH`; the worktree tests use temporary repositories),
`bunx vitest run --config vitest.config.ts src/sdk/vscode-runtime-builder.test.ts src/sdk/sdk-task-start-coordinator.test.ts`,
and in `webview-ui`, `bunx vitest run src/components/ciBoard`.
