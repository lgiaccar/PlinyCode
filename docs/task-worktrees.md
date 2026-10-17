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

The task header shows **Worktree** and the branch under the conversation's title, with an **Open in new window**
button that opens the worktree folder in a new VS Code window. History rows of worktree conversations carry a
small **worktree** marker, and searching history matches the branch name.

If the worktree cannot be created (git is not installed, the folder is not in a repository, the repository has
no commit yet, or the submodules cannot be checked out), the conversation does not start and an error row says
why. A failed submodule checkout leaves nothing behind: the half-made worktree and its branch are removed.

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
- The session metadata stores `worktree: { repoRoot, branch, path, sourceWorkspacePath }`, which `HistoryItem`
  carries and a resume keeps. Reopening a conversation whose worktree was deleted runs it in the window's folder,
  with an info row saying so.

## Not in v1

- **Merging back.** The branch stays local. Commit in the worktree and merge, rebase or push it yourself (or ask
  the agent to).
- **Cleanup.** Worktrees and branches stay after the conversation. Remove them with `git worktree remove <path>`
  and `git branch -D <branch>` when you are done. A worktree is a full working copy, so a large repository needs
  its own build in each one.
- **Background starts.** The checkbox applies to conversations started from the prompt box.

## For developers

| Path                                                        | Contents                                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `apps/vscode/src/services/git/worktrees.ts`                 | `ensureTaskWorktree` (branch name, location, submodules, notes), `isInGitRepository`, and the CI Board's `ensureWorktree`. |
| `apps/vscode/src/sdk/sdk-task-start-coordinator.ts`         | `TaskStartOptions.worktree`: creates the worktree before the session, moves the task into it, writes the metadata. |
| `apps/vscode/src/hosts/vscode/worktree-settings.ts`         | Reads `plinycode.worktrees.root` and the CI Board fallback.                                                 |
| `apps/vscode/proto/cline/task.proto`                        | `NewTaskRequest.worktree`, `TaskItem.worktree_branch` and `TaskService.openTaskWorktree`.                    |
| `apps/vscode/proto/cline/workspace.proto`                   | `WorkspaceService.isGitRepository`, which decides whether the checkbox is shown.                             |
| `apps/vscode/webview-ui/src/components/workspace/NewTaskWorkspacePicker.tsx` | The checkbox.                                                                              |
| `apps/vscode/webview-ui/src/components/chat/task-header/TaskWorktreeChip.tsx` | The task header's worktree line and its Open in new window button.                         |

Tests: `bun test src/services/git` (needs `git` on `PATH`; uses temporary repositories) and
`bunx vitest run --config vitest.config.ts src/sdk/sdk-task-start-coordinator.test.ts src/sdk/task-history-query.test.ts src/sdk/sdk-task-history.test.ts`
from `apps/vscode`; in `webview-ui`, `bunx vitest run src/components/workspace src/components/chat/task-header/TaskWorktreeChip.test.tsx`.
