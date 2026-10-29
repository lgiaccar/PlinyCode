# CI Board

The CI Board watches many pull requests and branches at once, on **GitHub** (Actions) and **Azure DevOps**
(Pipelines, cloud or on-premises). Each pull request shows one colored dot per pipeline and a badge when it
conflicts with its target branch.

When something fails, a free Pliny model reads the failed runs and says what broke and how serious it is. The
row's main button offers the fix that fits: a single fix (**Fix conflicts**, **Fix build** or **Recalibrate**) when
one thing is wrong, **Fix them all** when several are. Expanded, the row lists every pipeline with what is wrong
with it and its own fix. Each fix is an **action**: it opens a conversation in a git worktree of the branch, on the
free auto-router, where the agent fixes the problem and pushes. **Auto-watch** does the safe ones by itself: it
fixes conflicts and recalibrates small test deltas in the background.

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
sign-in prompt, since it polls in the background. A target that cannot sign in shows the error under its name.
Azure DevOps Server takes only a personal access token: when one is missing or rejected, the error has a **Sign in
to Azure DevOps Server** button that stores a token for that host and checks the target again (see
[devops-mcp.md](devops-mcp.md#azure-devops-server-personal-access-tokens)).

The board belongs to the window's workspace: each window shows, polls and notifies about its own. It is saved in
`ci-board.json` in PlinyCode's data directory and survives reloads.

## Reading it

The top line counts the pull requests that fail, conflict, are running and are green. **Failing only** hides the
rest. Within an entry, the worst pull requests come first.

Each row has:

- a **severity** chip (see [Failure triage](#failure-triage)), and a colored left edge to match;
- one **dot** per pipeline: a workflow (GitHub) or pipeline definition (Azure DevOps) on the pull request's head
  commit. If a pipeline ran more than once on that commit, the newest run sets the color;
- the pull request's number (a link) and title, and a **Conflicts** badge;
- an **auto-watch** badge when auto-watch is doing something about it;
- a second line with the triage's one-line summary, or the branches and author when nothing fails;
- the conversation the last action started, and the action buttons.

Azure DevOps PRs also show **Expired** when a build-validation policy has expired after a target-branch update.
Expand the row and use **Requeue pipeline** beside that validation to ask Azure DevOps to run it again. Expiration is a
policy state, so an earlier successful build can still have a green run dot. Requeue acts on one policy at a time
and does not start a code-fixing conversation.

An open Azure DevOps PR also has two direct controls in its **Actions** menu, beside **Fix conflicts** and **Fix build**:

- **Restart merge** asks Azure DevOps to recompute the preview merge against the current target branch, such as `stage`. Use it when an old PR may have new conflicts after the target branch advanced. It does not complete the PR, resolve conflicts, or push changes to the source branch.
- **Requeue pipeline** opens the PR's build-validation policies so you can choose which one to run again. It includes outdated results that Azure DevOps has not marked expired yet. Queued or running validations cannot be requeued. This re-evaluates the selected PR policy rather than retrying jobs on an old build commit; restart the preview merge first when the target branch has advanced.

Both controls use the configured Azure DevOps credentials, work without a local checkout, and show pending, submitted, or error feedback. The board refreshes after the request. PlinyCode rechecks the PR and policy state before sending it, rejects duplicate in-flight actions, and never starts these actions through auto-watch.

| Color  | Meaning                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------- |
| Green  | Passed.                                                                                                   |
| Red    | Failed or partially succeeded.                                                                            |
| Yellow | Queued or running.                                                                                        |
| Grey   | Cancelled or skipped, or no run on this commit for a pipeline that ran on an earlier one: a new push whose runs have not started, a pipeline whose path filter skipped it, or an Azure DevOps PR build that never queued because the PR conflicts. |

Click a dot to open its run. **Conflicts** means the pull request does not merge cleanly into its target branch;
**Checking merge…** means GitHub or Azure DevOps is still working that out. Every control has a tooltip that says
what it does.

The chevron at the start of a row expands it from the compact line of dots into one line per pipeline:

```text
● Merge into stage   → Has conflicts      [Fix conflicts]
● win_cpu            → OK
● linux_build        → Build failed       [Fix build ▾]
● regression_tests   → Small test delta   [Recalibrate ▾]
● gpu_tests          → Infrastructure     [Actions ▾]
[Fix them all]  Works out each problem and applies the fix that fits it, one after the other.
```

- The merge line appears when the pull request conflicts.
- Each pipeline shows **OK**, **Running**, **Queued** or **Not run**, or, when it failed, the triage's
  [category](#failure-triage), its one-line summary, and each failed job › step with its first errors and the last log
  lines. The arrow icon opens its run.
- A failed pipeline's button is the single fix that fits it, run on **that pipeline only**: **Fix build** for a build
  failure, a test regression or an unclear failure, **Recalibrate** for a small test delta. Infrastructure failures
  and stale runs have no fix (re-run them in CI). The chevron beside it runs **Fix build**, **Recalibrate** or
  **Investigate** on the pipeline instead, for when the triage is wrong.
- **Fix them all** runs the broad fix on the whole pull request.

While a run the board started is going, the fix buttons are disabled and the pipeline it fixes says **fixing**.
**Open full report** opens the [markdown report](#reports) when the details did not fit; **Analyze again** reads the
runs again.

## Failure triage

When an item fails or conflicts, the board reads the failed runs (`runReport`: the failed jobs and steps, their
error messages and the end of their logs) and sends them to the router's free utility summarizer model
(`rules.utility.summarizer` in the [router rules](pliny-free-auto-router.md)) in one request. The model classifies each
failed pipeline:

| Category           | Meaning                                                                                       | Severity |
| ------------------ | --------------------------------------------------------------------------------------------- | -------- |
| Build              | Compiling, linking, packaging, lint or type checking fails.                                   | Blocker  |
| Test failure       | Tests fail because of a real defect: a crash, an assertion, clearly worse results.            | High     |
| Conflicts          | The pull request does not merge cleanly.                                                      | High     |
| Unclear            | Not enough evidence.                                                                          | Medium   |
| Small delta        | Tests fail only because measured values moved slightly (over a tolerance, an improvement, noise). | Low      |
| Infrastructure     | An agent, network, disk, service or artifact problem unrelated to the code.                   | Low      |
| Stale run          | The run tested an older commit.                                                               | Info     |

The item's severity is its worst category's. The severity and the recommended actions are worked out from the
categories, not by the model, so they stay stable:

- conflicts → **Fix conflicts**;
- every failure a small delta → **Recalibrate**;
- any build, test or unclear failure → **Fix them all** (each failed pipeline also gets its own **Fix build** or
  **Recalibrate** in the [expanded row](#reading-it));
- only infrastructure → **Investigate** (and a re-run).

The model also says how sure it is that *every* failure is a small delta; auto-watch uses that.

When the model does not answer or its answer cannot be read, rules on job, step and error text classify the
failures instead, and the details say so. Rules never call a failure a small delta, so auto-watch never
recalibrates on their word.

Triage runs once per **state** of an item: its head commit, its red runs and whether it conflicts. It runs for what
was already red when the board started, too. At most four red runs are read per item, two items at a time. When
fewer than 500 GitHub requests are left, triage uses pipeline names only and tries again once the limit recovers.
The result (without its step details) is saved with the board, so it survives a reload; **Analyze again** reads the
details back. The model call costs nothing and needs no budget check.

`plinycode.ci.board.triage` is `auto` (the default), `onDemand` (only from **Analyze**) or `off`.

### Reports

When an item's details are longer than the board shows (8000 characters, more than five errors in a step, or a log
cut short), the full report goes to a markdown file: `.plinycode/ci-reports/<pr-N|branch>-<sha>.md` in the
repository's checkout. It has the triage, the job table of each failed run, every error and the log tails. The
board adds `/.plinycode/` to the repository's `.git/info/exclude` (its common git directory, which its worktrees
share), so the reports never show in `git status` and no tracked `.gitignore` changes. The 50 newest reports are
kept.

Runs started from the board are told the report's path, and read it before calling `pipeline_report`.

## Actions

Every entry has five built-in actions. The single fixes (Fix conflicts, Fix build, Recalibrate) each do one
atomic thing; **Fix them all** is the broad fix, which works out every problem and applies the fix that fits each
one, so it does more and is more fragile. The row's **main button** follows that: the single fix when one thing is
wrong, Fix them all when several are. The others, your own actions and the tools below are in the **menu** beside it
(the chevron).

| Action            | Main button when                                | What it does                                                                                     | Mode  |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----- |
| **Fix conflicts** | the pull request conflicts and no pipeline fails | Merges the target branch in and resolves the conflicts, keeping both sides' intent. Generated and measured files are regenerated, not hand-merged. Pushes. | Agent |
| **Fix build**     | one pipeline fails, with a build, test regression or unclear failure (scoped to it) | Fixes what breaks the pipeline in the code: build, compile, lint, or tests failing on a defect. Never changes expected test values. Pushes. | Agent |
| **Recalibrate**   | one pipeline fails with a small delta (scoped to it), or the triage says every failure is a small delta | Updates the expected values of tests that moved slightly, with the repository's own tooling. Never for a regression; stops when the repository documents no tooling. | Agent |
| **Fix them all**  | several things are wrong, or one with no single fix | Resolves conflicts first, then works out each failed pipeline's problem and applies the fix that fits it (fix the build, fix a regression, recalibrate a small delta, report infrastructure), pushes and calls `watch_ci`. | Agent |
| **Investigate**   | never (menu only)                               | Explains each failure with its evidence and the next step to take. Edits nothing.                | Ask   |

A fix **scoped to a pipeline** (the main button for a single failed pipeline, or a button in the expanded row) is
told, in a **Scope** section of its header, to fix only that pipeline and run, with that pipeline's triage, and to
leave the other failed pipelines alone. Run from the menu, Fix build and Recalibrate apply to every failed pipeline
they fit. A pull request has one board run at a time, since runs share its worktree. Boards saved with the old
**Fix CI** name show **Fix them all**; a name you chose stays.

While a run the board started is still going, the main button is **Open conversation**. The menu also has:

- **Run a custom prompt…**: write a prompt, or pick a prompt file, and run it on this pull request once, on FreeAuto
  or on the chat's model. **Keep as an action** saves it to the entry.
- **Analyze failures again**, **Open pull request**, and **Edit actions…**.

**Edit actions** (also the gear on the entry) changes, per entry:

- each built-in action's name, its prompt (the built-in one, a prompt file, or text), its model, and whether
  auto-watch may run it (Fix conflicts and Recalibrate only);
- your own actions: a name, a prompt file or text, a model, and whether it is the main button on conflicts, on
  failures, on small deltas, or menu only.

A prompt file can be Markdown or text. A relative path is looked up in the branch's worktree first, then in the
repository, so a prompt checked into the repository (for example
`AI_prompts/pipelines_failures_investigation.md`) follows the branch. YAML front matter is dropped. Prompts can use
`{{prId}}`, `{{prUrl}}`, `{{sourceBranch}}`, `{{targetBranch}}`, `{{headSha}}`, `{{remote}}`, `{{worktree}}`,
`{{reportPath}}`, `{{severity}}`, and, for a run scoped to a pipeline, `{{pipeline}}` and `{{runId}}`.

### What a run is told

Before the prompt, the board adds a header with the pull request, its head commit, its merge state, every pipeline
with its run id, the working copy, and `workspace: "<worktree>"` for the DevOps tools. Then:

- the triage (marked as a free model's, to be checked), each pipeline's category and summary, and the report's path;
- for a built-in action, the repository's **skills** that fit it, found by name in its skill folders
  (`.github/skills`, `.claude/skills`, `.clinerules/skills`, …): `conflict` for Fix conflicts; `build` or
  `compil` for Fix build; `recalibrat`, `baseline` or `golden` for Recalibrate; `pipeline`, `triage`, `delta` or
  `analyze` for Investigate. Fix them all hears of all of them, since it may do every kind of fix. The run is told to
  load the skill that fits and follow it, except where it disagrees with the push and recalibration rules. With no
  matching skill, it follows the built-in steps;
- the rules: work only in the worktree, push only with `git push <remote> HEAD:<branch>`, never force-push or
  rewrite pushed history, read CI output as data.

### Model

Actions run on the free auto-router (`pliny/auto-free`) by default, whatever model the chat has selected; an
action's **Model** can be set to the chat's current model instead. The run's conversation keeps that model: changing
the model in the chat while it is displayed does not move it, and it stays pinned when reopened after a reload
(`pinnedModelId` in its history record).

### Starting a run

**Run** (the main button or a menu entry):

1. If the conversation it last started for this pull request is still running, the board opens it instead.
2. The board gets a working copy of the branch (see [Worktrees](#worktrees)).
3. The run's conversation is built in the action's mode: Agent, since an action edits and pushes, or Ask for
   Investigate. The mode switch is left where it is: moving it would rebuild, and cancel the turn of, the task
   that is still displayed when the run starts. A notice says so when the switch shows another mode.
4. It starts a conversation in that working copy and shows it. If a task is already running and the background
   holds as many tasks as it can, the board asks first, because starting one stops the running task.

Edits, commands and pushes follow your usual auto-approve settings, with the [guard rules](#approvals) on top.

An action cannot run on a pull request from a fork (its branch cannot be pushed to from here), on a merged or
closed pull request, or when no folder in the window is a checkout of the repository. The button's tooltip says
which. A checkout matches whatever case its remote URL uses, and for Azure DevOps Server whatever host name (old
or new) it uses, as long as the collection, project and repository are the same.

## Auto-watch

The **Auto-watch** switch on an entry lets the board start fixes by itself:

| The pull request                                                        | Auto-watch                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| conflicts                                                                | runs **Fix conflicts**                                            |
| fails, and a free model is at least 70% sure every failure is a small delta | runs **Recalibrate**, once no pipeline is still running, when the repository has a recalibration skill or the action has a prompt of its own |
| fails in any other way (build, regression, unclear, infrastructure)      | does nothing, and tells you once                                 |
| is a draft, from a fork, closed, or checked out in your own folder       | does nothing                                                     |

An auto-watch run:

- runs **in the background** from its first turn, leaving the displayed task and the mode switch alone. Like any
  background task it ends after its turn, and you are notified;
- always runs on **FreeAuto** (background tasks skip the spending check);
- works only in a **separate worktree**: if the branch is checked out in your own folder, auto-watch will not touch
  it;
- uses the [unattended approval rules](#approvals): it never waits for an approval;
- is told nobody is watching, and does not call `watch_ci`: the board's own polling sees the result.

Limits:

- at most `plinycode.ci.board.autoWatch.maxAttempts` (2) runs of one action on one commit, and 3 on one pull
  request until it turns green;
- at most `plinycode.ci.board.autoWatch.maxConcurrentRuns` (1) runs at once, and one background slot is always left
  for your own tasks; a run that has to wait shows **Auto: waiting for a slot** and starts when one frees up;
- after a run ends, auto-watch waits two minutes for CI to pick up its push before it looks at the item again.

The counters are saved with the board. The row's badge says what auto-watch is doing (**fixing 1/2**, **queued**,
**waiting**, **needs you**, **gave up**), with the reason in its tooltip. With auto-watch on, the board's failure
notifications come from auto-watch: one when it starts a run (with **Open conversation**), and one when it leaves a
pull request to you.

## Approvals

Runs the board starts have their own approval rules, checked before your auto-approve settings
([ci-run-policy.ts](../apps/vscode/src/sdk/ci-run-policy.ts)).

| Tool call                                                              | Run you started          | Auto-watch run |
| ---------------------------------------------------------------------- | ------------------------ | -------------- |
| `git push <remote> HEAD:<branch>` (or `<branch>`, `refs/heads/<branch>`) | your settings            | approved       |
| a force push (`-f`, `--force*`, a `+` refspec), `--delete`, `--mirror`, `--all`, `--tags`, `:<branch>`, another branch or remote | refused | refused |
| a bare `git push`                                                       | asks                     | refused, with the command to use instead |
| editing a file outside the worktree, or inside `.git`                   | refused                  | refused        |
| `rm`, `mv`, `cd`, `Remove-Item`, … or a `>` redirection to a path outside the worktree; `git -C <elsewhere>` | refused | refused |
| `git rebase`, `commit --amend`, `branch -D`, `worktree`, `remote`, `config --global`; `sudo`; piping a download to a shell; `gh`/`az` commands that change things | your settings | refused |
| reading outside the worktree and the report folder; MCP tools other than the DevOps server's read-only ones (`pr_review`, `pr_comment`, `pipeline_run`, `pipeline_cancel` and `pipeline_rerun` are refused with a reason of their own, see [devops-mcp.md](devops-mcp.md#unattended-ci-board-runs)); web tools; `save_memory` | your settings | refused |
| anything else (editing in the worktree, builds, tests, reads)           | your settings            | approved       |

A refusal comes back to the model with the reason, so it can correct itself (for example push with the explicit
form) or report. Command parsing is best effort (a command hidden in `bash -c` is not seen); the worktree and the
narrow push rule are the real boundary. An auto-watch run you reopen from the background gets the rules of a run you
started.

## Worktrees

A pull request whose branch is checked out in the window's repository runs right there, beside any changes you
have open (auto-watch refuses this case). Any other branch gets a git worktree, so several pull requests can be
worked on at once without touching your checkout:

- It goes in `<repository>.worktrees/<branch>` next to the repository, or under `plinycode.ci.worktreeRoot`.
  Branch names are shortened and given a hash where needed, for Windows path limits.
- The board fetches the branch first. An existing worktree of the branch is reused and fast-forwarded when it is
  clean; with local changes or local commits it is left alone, and the agent is told so.
- Submodules are checked out when the repository has them.
- Worktrees stay after the run, so a follow-up action reuses the build. PlinyCode's daily cleanup removes a
  board worktree once it is clean and its conversation was deleted or has been idle for
  `plinycode.worktrees.keepDays` days (default 7); its branch is kept, and the next action makes a new
  worktree. **PlinyCode: Manage Worktrees** lists them and removes one on demand. See
  [task-worktrees.md](task-worktrees.md#cleanup). A worktree is a full working copy, so a C++ repository needs a
  full build in each one.

Conversations started in a worktree are bound to it ([workspace-conversations.md](workspace-conversations.md)), so
they appear in History under **All workspaces**, or from the board's conversation link. Worktrees are not added
to the recently used workspaces.

## Polling and rate limits

The board checks every `plinycode.ci.board.pollSeconds` (60) while it is on screen and every
`plinycode.ci.board.hiddenPollSeconds` (180) otherwise, so notifications and auto-watch keep working. Each check
lists each entry's pull requests, but asks for a pull request's runs only when something can have changed:

- its head commit moved;
- a run is still going;
- its merge state is still being computed;
- or 10 minutes have passed (this catches re-runs).

On GitHub, unchanged answers come back as `304 Not Modified`, which does not count against the rate limit. An
idle repository with 20 open pull requests costs about 60 listing requests an hour, plus each pull request's runs
every 10 minutes. Triage adds a few requests per failed run, once per state. When fewer than 500 GitHub requests
are left, the board checks four times less often and only looks at new commits until the limit resets; a note at
the top says so.

Without auto-watch, notifications come once per failure: a pipeline that stays red on the same commit is not
reported again, and nothing is reported for what was already red when the board started.

## Settings

| Setting                                         | Default | What it does                                                    |
| ----------------------------------------------- | ------- | --------------------------------------------------------------- |
| `plinycode.ci.board.pollSeconds`                | `60`    | Seconds between checks while the board is on screen (min. 30).  |
| `plinycode.ci.board.hiddenPollSeconds`          | `180`   | Seconds between checks while it is not (min. 30).               |
| `plinycode.ci.board.notify`                     | `true`  | Notify when a pipeline fails or a pull request conflicts, and about auto-watch. |
| `plinycode.ci.board.maxPrsPerRepo`              | `30`    | Most open pull requests listed per repository.                  |
| `plinycode.ci.board.triage`                     | `auto`  | `auto`, `onDemand` or `off`: when a free model analyses failures. |
| `plinycode.ci.board.autoWatch.maxAttempts`      | `2`     | Auto-watch runs of one action on one commit (1–5).              |
| `plinycode.ci.board.autoWatch.maxConcurrentRuns` | `1`    | Auto-watch runs at once (1–2).                                  |
| `plinycode.ci.worktreeRoot`                     | `""`    | Folder for the board's worktrees; empty means next to the repository. |

## For developers

| Path                                                          | Contents                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/vscode/src/services/devops-mcp/ci-board/`               | The board, no `vscode` import: targets and store (`ci-board.ts`, `ci-board-store.ts`, version 2 with the version 1 migration), polling (`ci-board-poller.ts`), dots and transitions (`ci-board-snapshot.ts`), triage and reports (`ci-triage.ts`, `report-dir.ts`), the row's actions, its per-pipeline fixes and their tooltips (`ci-board-actions.ts`), skill detection (`ci-skills.ts`), the built-in prompts (`builtin-prompts.ts`) and the header (`ci-prompt.ts`), auto-watch (`ci-auto-runner.ts`) and PR links. |
| `apps/vscode/src/services/git/worktrees.ts`                   | The worktree helpers (`ensureWorktree`, `worktreeRoot`), shared with **Run in worktree** ([task-worktrees.md](task-worktrees.md)). |
| `apps/vscode/src/services/devops-mcp/host/CiBoardHost.ts`     | Builds the window's board with the editor's sign-in and the free utility model, finds checkouts among the window's folders, runs auto-watch, turns transitions into notifications. |
| `apps/vscode/src/sdk/ci-run-policy.ts`                        | The approval rules of board runs; `SdkInteractionCoordinator`'s `sessionPolicy` applies them first. |
| `apps/vscode/src/sdk/sdk-task-start-coordinator.ts`           | `startBackgroundTask` (a task that starts in the background) and `TaskStartOptions.modelId` (a pinned model, kept by `SdkSessionConfigBuilder.pinModel`). |
| `apps/vscode/src/services/devops-mcp/server/providers/`       | `listOpenPrs`, `branchHead`, merge state, forks and pipeline names, added for the board; GitHub ETag revalidation. |
| `apps/vscode/proto/cline/ci_board.proto`, `src/core/controller/ciBoard/` | The webview's `CiBoardService` and its handlers; `start-ci-run.ts` starts an action (`startCiRun`) or an auto-watch run (`startCiAutoRun`). |
| `apps/vscode/webview-ui/src/components/ciBoard/`              | The view: rows (`CiItemRow`), the split button (`CiActionBar`), the pipeline-by-pipeline view (`CiItemDetails`), the editor, the custom prompt panel. |

A conversation in a worktree runs the DevOps tools against the worktree: `BuiltinMcpSource.providerFor(cwd)`
fills in `workspace` for calls that leave it out, where the server would otherwise use the window's first folder.

Tests: `bun test src/services/devops-mcp src/services/git` (needs `git` on `PATH`; the worktree and report tests use temporary
repositories); `bunx vitest run --config vitest.config.ts src/sdk/ci-run-policy.test.ts src/sdk/sdk-task-start-coordinator.test.ts src/sdk/sdk-session-config-builder.test.ts src/sdk/sdk-interaction-coordinator.test.ts`;
and in `webview-ui`, `bunx vitest run src/components/ciBoard`.
