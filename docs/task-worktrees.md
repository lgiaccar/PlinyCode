# Run in worktree

**Run in worktree** starts a conversation on a new git branch, in a worktree of its own next to the repository.
The agent edits, builds and runs commands there, so your checkout is not touched, and several conversations can
change the same repository at once without seeing each other's edits.

## Using it

While no conversation is open, the **Start in** row above the prompt box has a **Run in worktree** checkbox. It is
shown only when the chosen workspace (the window's, or one picked in the dropdown) is in a git repository, and
it applies to the next conversation only: it clears itself after the send, and picking a workspace that is not a
repository unticks it.

When the conversation starts:

1. PlinyCode creates the branch `<user>/<title>-<4 hex>` from the repository's current commit (`HEAD`), for
   example `lgiaccar/fix-the-login-page-3f2a`. `<user>` is your operating-system user name, lowercase, with
   characters git does not allow in a branch name replaced by `-` (`plinycode` when there is none). The title
   part is the first words of the prompt, lowercase, at most 40 characters. Nothing is fetched. The branch is
   marked as PlinyCode's in the repository's git config (`branch.<name>.plinycodetask = true`), which is how the
   cleanup tells it from your own branches; git removes the mark with the branch.
2. It adds a worktree of that branch (see [Where worktrees go](#where-worktrees-go)) and checks out its
   submodules, if the repository has any.
3. The conversation runs in the worktree. When the workspace is a folder below the repository's top level, it
   runs in the same subfolder of the worktree.

An info row in the chat says which branch and folder the conversation works in. Uncommitted changes in your
checkout are not in the worktree, which starts from the last commit; the row says so when there are any.

The task header shows **Worktree**, the branch, and the full folder path under the conversation's title. Click the
path to open the folder in a new VS Code window, or use **Copy path**. The path remains visible after removal,
marked **removed**. History rows of worktree conversations
carry a small **worktree** marker, and searching history matches the branch name.

If the worktree cannot be created (git is not installed, the folder is not in a repository, the repository has
no commit yet, or the submodules cannot be checked out), the conversation does not start and an error row says
why. A failed submodule checkout leaves nothing behind: the half-made worktree and its branch are removed.

## Bringing the work back

The worktree line in the task header has these buttons after the branch and path:

| Button                 | What it does                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| **Open in new window** | Opens the worktree folder in a new VS Code window.                                                   |
| **Copy path**          | Copies the full worktree folder path.                                                                  |
| **Apply**              | Applies the worktree's changes to the checkout it was branched from and stages them there.           |
| **Create PR**          | Commits what is uncommitted, pushes the branch and opens a draft pull request.                      |
| **Remove worktree**    | Removes the worktree, and its branch when it is merged or you choose to delete it.                   |

Apply, Create PR and Remove worktree each ask in a modal dialog before they do anything, and add an info row to
the chat saying what they did. They refuse while the conversation is running (on screen or in the background).
A refusal is an error message and changes nothing.

### Apply

Apply brings the worktree's changes into the checkout the conversation was started from (`worktree.repoRoot`):
the commits on the branch since the commit it was branched from, plus the worktree's uncommitted changes and new
files that are not ignored. PlinyCode writes them as one patch and applies it with `git apply --3way --index` in
the checkout, so the changes end up **staged, not committed**. Review and commit them there yourself.

- The commit the branch was branched from is recorded as `worktree.baseCommit` when the worktree is made.
  Worktrees made before that was recorded use the merge base of the worktree's `HEAD` and the checkout's `HEAD`.
- Apply refuses when the checkout has uncommitted changes (staged, unstaged or untracked) to any path the patch
  touches. Changes to other paths are left alone.
- Before applying, it runs `git apply --check --3way --index`. When the patch would not apply, or would leave
  conflict markers in a file, nothing is applied, and the message names the files. The checkout is never left
  half-applied; merge the branch yourself in that case.
- The worktree itself is not changed: the patch is built in a temporary index.

### Create PR

Create PR uses the DevOps server's provider code ([devops-mcp.md](devops-mcp.md)) directly, with the editor's
existing sign-in, not through the MCP transport. When the repository has no GitHub or Azure DevOps remote the
server works with, or the DevOps service has not started, the error says so.

1. It reads the repository's default branch and whether the branch already has an open pull request.
2. The modal says what will happen: the uncommitted changes (if any) are committed with the conversation's title
   as the message (first line, at most 72 characters), the branch is pushed to the remote (`origin`, or
   `DEVOPS_MCP_REMOTE`) with `git push -u`, and a **draft** pull request is opened into the default branch. The
   description names the conversation and lists the branch's commits.
3. When the branch already has an open pull request, the button is **Push** instead: the commit and push update
   that pull request, and no new one is opened.

A branch with no commits and no uncommitted changes since its base has nothing to propose; Create PR refuses it.

### Remove worktree

Remove worktree runs `git worktree remove` for the worktree folder. The modal depends on the worktree's state:

- **Uncommitted changes:** the modal says how many and offers **Discard and remove**, which forces the removal
  (`--force`). Without that choice nothing is removed.
- **Branch merged** into the checkout's `HEAD` (including a branch with no commits of its own): the branch is
  deleted with the worktree.
- **Branch not merged:** the modal says how many commits the checkout does not have and offers **Remove, keep
  branch** and **Remove and delete branch**.
- **Folder already gone:** the modal offers to forget it (`git worktree prune`).

The conversation keeps its history. Its worktree record gets `removedTs`, the header shows the branch as
**(removed)** without buttons, and the conversation, when it is on screen, is resumed at once in the checkout it
was branched from (the same subfolder when there is one), with an info row saying so. Reopening it later does the
same.

## Where worktrees go

| Setting                     | Default | What it does                                                                     |
| --------------------------- | ------- | -------------------------------------------------------------------------------- |
| `plinycode.worktrees.root`  | `""`    | Folder for conversation worktrees; each repository gets a subfolder named after it. |
| `plinycode.ci.worktreeRoot` | `""`    | The CI Board's folder, used when `plinycode.worktrees.root` is empty.           |

With both empty, a worktree goes next to the repository, in `<repository>.worktrees/<title>-<4 hex>`, like the
[CI Board's](ci-board.md#worktrees). The folder name repeats at most 24 characters of the title, to keep Windows
paths short. A worktree started from a conversation that itself runs in a worktree still goes next to the main
checkout, not inside the other worktree's folder.

## Cleanup

PlinyCode removes the worktrees it made once they are no longer needed. The cleanup runs in the background five
minutes after the window opens and then once a day; when another window already ran it in the last 20 hours
(a stamp, `worktree-cleanup.json`, in PlinyCode's data folder), it skips that turn.

| Setting                        | Default | What it does                                                                           |
| ------------------------------ | ------- | -------------------------------------------------------------------------------------- |
| `plinycode.worktrees.keepDays` | `7`     | Days a PlinyCode worktree is kept after its conversation was last active. `0` turns the cleanup off. |

**Which worktrees it looks at.** The repositories PlinyCode knows: those of conversations with a worktree record,
and those of the CI Board's runs (its `ci-board.json`). In each, only worktrees under one of the worktree folders
(`plinycode.worktrees.root`, `plinycode.ci.worktreeRoot`, and `<repository>.worktrees`) that PlinyCode made:
a branch marked as made by Run in worktree (or named `plinycode/*`, as they were before branches were named
after the user), or a folder a CI Board run works in. A worktree you made yourself is not
touched, even in the same folder.

**When it removes one.** All of these must hold:

- it has no uncommitted changes (`git status` lists nothing, untracked files included);
- it is not the main checkout, and no folder open in this window is in it;
- no conversation that works in it is running, on screen or in the background;
- it is more than an hour old (a new conversation's worktree exists a moment before its history entry);
- its conversation was deleted, or has been idle (no activity) for more than `keepDays` days. A CI Board
  worktree counts the latest of its runs' start times and their conversations' activity.

It runs `git worktree remove` without `--force`, so git itself refuses one that changed in the meantime. A
Run in worktree branch is then deleted with `git branch -d`, which git refuses unless the branch is merged; any
other branch (a CI Board run's pull request branch) is kept. A conversation whose worktree was removed is marked
(`removedTs`) like after **Remove worktree**. Each removal, and each failure, is written to PlinyCode's log
(**PlinyCode: Open Log File**).

### Manage Worktrees

**PlinyCode: Manage Worktrees** (command palette) lists every PlinyCode worktree the cleanup would look at, with
its branch, whether it is a conversation's or the CI Board's, whether it has uncommitted changes, and how long its
conversation has been idle (or that it was deleted). Picking one offers **Open in New Window**, **Open
Conversation** and **Remove Worktree**. Removing a conversation's worktree is the same as its **Remove worktree**
button; any other asks in the same kind of modal, and never deletes a CI Board run's branch.

This is a command rather than a section in the History view because worktrees do not map one to one onto history
rows: CI Board worktrees and the worktrees of deleted conversations have no row of their own. The command reuses
VS Code's quick pick and modal dialogs and needs no new webview state; the task header already has the
per-conversation buttons.

## How it fits together

Isolation is a property of the session's working directory. The conversation is started with the worktree as
its `cwd` and workspace root, so its file tools, shell commands, checkpoints, **View changes** and the
reviewer's diff ([review-pass.md](review-pass.md)) all cover the worktree only. This is what the CI Board does
for its runs; Run in worktree gives ordinary conversations the same entry point.

- The conversation is bound to the worktree folder as a `folder` workspace
  ([workspace-conversations.md](workspace-conversations.md)). History filtered by the workspace it was started
  from lists it too, through `worktree.sourceWorkspacePath`.
- The workspace the user picked is recorded as recently used; the worktree is not.
- The session metadata stores `worktree: { repoRoot, branch, path, sourceWorkspacePath, baseCommit, removedTs }`,
  which `HistoryItem` carries and a resume keeps. Reopening a conversation whose worktree was deleted runs it in
  the checkout it was branched from (the same subfolder when it exists), else in the window's folder, with an info
  row saying so.

## Not in v1

- **Background starts.** The checkbox applies to conversations started from the prompt box.

## For developers

| Path                                                        | Contents                                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `apps/vscode/src/services/git/worktrees.ts`                 | `ensureTaskWorktree` (branch name, location, base commit, submodules, notes), `isInGitRepository`, and the CI Board's `ensureWorktree`. |
| `apps/vscode/src/services/git/worktree-merge.ts`            | The git side of Apply (patch, overlap check, `apply --check`), Create PR (commit, push) and Remove worktree.  |
| `apps/vscode/src/core/controller/task/worktree-action-runner.ts` | The three actions: refusals, modals, info rows and the DevOps provider call. `worktreeAction.ts` wires it to the editor. |
| `apps/vscode/src/services/git/worktree-gc.ts`               | The cleanup: `findPlinyWorktrees` (which worktrees), `gcVerdict` (the rules) and `collectWorktreeGarbage`. |
| `apps/vscode/src/hosts/vscode/worktree-lifecycle.ts`        | Schedules the cleanup, reads `plinycode.worktrees.keepDays`, and the Manage Worktrees command.              |
| `apps/vscode/src/sdk/sdk-task-start-coordinator.ts`         | `TaskStartOptions.worktree`: creates the worktree before the session, moves the task into it, writes the metadata. |
| `apps/vscode/src/hosts/vscode/worktree-settings.ts`         | Reads `plinycode.worktrees.root` and the CI Board fallback.                                                 |
| `apps/vscode/proto/cline/task.proto`                        | `NewTaskRequest.worktree`, `TaskItem.worktree_branch`, `TaskService.openTaskWorktree` and `TaskService.worktreeAction`. |
| `apps/vscode/proto/cline/workspace.proto`                   | `WorkspaceService.isGitRepository`, which decides whether the checkbox is shown.                             |
| `apps/vscode/webview-ui/src/components/workspace/NewTaskWorkspacePicker.tsx` | The checkbox.                                                                              |
| `apps/vscode/webview-ui/src/components/chat/task-header/TaskWorktreeChip.tsx` | The task header's worktree line and its buttons.                                          |

Tests: `bun test src/services/git src/core/controller/task/__tests__/worktree-action-runner.test.ts` (needs `git` on `PATH`; uses temporary repositories) and
`bunx vitest run --config vitest.config.ts src/core/controller/task/__tests__/worktreeAction.test.ts src/sdk/sdk-task-start-coordinator.test.ts src/sdk/task-history-query.test.ts src/sdk/sdk-task-history.test.ts`
from `apps/vscode`; in `webview-ui`, `bunx vitest run src/components/workspace src/components/chat/task-header/TaskWorktreeChip.test.tsx`.
