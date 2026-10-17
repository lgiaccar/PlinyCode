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

1. PlinyCode creates the branch `plinycode/<title>-<4 hex>` from the repository's current commit (`HEAD`). The
   title part is the first words of the prompt, lowercase, at most 40 characters. Nothing is fetched.
2. It adds a worktree of that branch (see [Where worktrees go](#where-worktrees-go)) and checks out its
   submodules, if the repository has any.
3. The conversation runs in the worktree. When the workspace is a folder below the repository's top level, it
   runs in the same subfolder of the worktree.

An info row in the chat says which branch and folder the conversation works in. Uncommitted changes in your
checkout are not in the worktree, which starts from the last commit; the row says so when there are any.

The task header shows **Worktree** and the branch under the conversation's title, with buttons to open the
worktree in a new VS Code window and to bring the work back (see below). History rows of worktree conversations
carry a small **worktree** marker, and searching history matches the branch name.

If the worktree cannot be created (git is not installed, the folder is not in a repository, the repository has
no commit yet, or the submodules cannot be checked out), the conversation does not start and an error row says
why. A failed submodule checkout leaves nothing behind: the half-made worktree and its branch are removed.

## Bringing the work back

The worktree line in the task header has four buttons after the branch name:

| Button                 | What it does                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| **Open in new window** | Opens the worktree folder in a new VS Code window.                                                   |
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

- **Cleanup.** Worktrees and branches stay after the conversation. Remove them with `git worktree remove <path>`
  and `git branch -D <branch>` when you are done. A worktree is a full working copy, so a large repository needs
  its own build in each one.
- **Background starts.** The checkbox applies to conversations started from the prompt box.

## For developers

| Path                                                        | Contents                                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `apps/vscode/src/services/git/worktrees.ts`                 | `ensureTaskWorktree` (branch name, location, base commit, submodules, notes), `isInGitRepository`, and the CI Board's `ensureWorktree`. |
| `apps/vscode/src/services/git/worktree-merge.ts`            | The git side of Apply (patch, overlap check, `apply --check`), Create PR (commit, push) and Remove worktree.  |
| `apps/vscode/src/core/controller/task/worktree-action-runner.ts` | The three actions: refusals, modals, info rows and the DevOps provider call. `worktreeAction.ts` wires it to the editor. |
| `apps/vscode/src/sdk/sdk-task-start-coordinator.ts`         | `TaskStartOptions.worktree`: creates the worktree before the session, moves the task into it, writes the metadata. |
| `apps/vscode/src/hosts/vscode/worktree-settings.ts`         | Reads `plinycode.worktrees.root` and the CI Board fallback.                                                 |
| `apps/vscode/proto/cline/task.proto`                        | `NewTaskRequest.worktree`, `TaskItem.worktree_branch`, `TaskService.openTaskWorktree` and `TaskService.worktreeAction`. |
| `apps/vscode/proto/cline/workspace.proto`                   | `WorkspaceService.isGitRepository`, which decides whether the checkbox is shown.                             |
| `apps/vscode/webview-ui/src/components/workspace/NewTaskWorkspacePicker.tsx` | The checkbox.                                                                              |
| `apps/vscode/webview-ui/src/components/chat/task-header/TaskWorktreeChip.tsx` | The task header's worktree line and its buttons.                                          |

Tests: `bun test src/services/git src/core/controller/task/__tests__/worktree-action-runner.test.ts` (needs `git` on `PATH`; uses temporary repositories) and
`bunx vitest run --config vitest.config.ts src/core/controller/task/__tests__/worktreeAction.test.ts src/sdk/sdk-task-start-coordinator.test.ts src/sdk/task-history-query.test.ts src/sdk/sdk-task-history.test.ts`
from `apps/vscode`; in `webview-ui`, `bunx vitest run src/components/workspace src/components/chat/task-header/TaskWorktreeChip.test.tsx`.
