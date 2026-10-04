# Conversations bound to workspaces

Every conversation belongs to a workspace. History shows the current window's conversations by default, a
conversation can be started in another workspace than the one the window is open on, and every PlinyCode
window on the machine sees the same set of conversations.

## What a workspace is

A workspace is identified by one path, its **workspace path**:

| The user opens                                       | Kind            | Workspace path                            | Folders                     |
| ---------------------------------------------------- | --------------- | ----------------------------------------- | --------------------------- |
| A folder                                             | `folder`        | the folder                                | that folder                 |
| A `.code-workspace` file listing **one** folder      | `folder`        | that folder                               | that folder                 |
| A `.code-workspace` file listing **several** folders | `workspaceFile` | the `.code-workspace` file                | the listed folders, in order |
| A multi-root window with no saved workspace file     | `folder`        | the first folder                          | the first folder            |

A `.code-workspace` file with a single folder is the same workspace as that folder, so opening the folder
directly and opening the file bind the same conversations. Folder entries in the file are resolved relative to
the file's directory; `file:` URIs are accepted, remote URIs are skipped. The file is parsed as JSON5 because VS
Code writes comments and trailing commas into it.

Workspace paths are compared with `arePathsEqual` in the extension host and `workspacePathsEqual` in shared code:
separator style and a trailing slash do not matter, and Windows paths compare case-insensitively.

Code: `apps/vscode/src/shared/workspaceRef.ts` (types and pure helpers, shared with the webview) and
`apps/vscode/src/core/workspace/workspace-identity.ts` (reads `.code-workspace` files and resolves the
window's workspace). The host bridge's `getWorkspacePaths` reports the window's saved `.code-workspace` file
next to its folders.

## Binding a conversation

When a task starts, the session record gets `workspacePath` and `workspaceKind` in its metadata, both in the
initial `sessionMetadata` of the start input and in the first history write, and `HistoryItem` carries the
same two fields. Resuming a task keeps them (`historyItemToSessionMetadata`). A conversation recorded before
this feature has no binding and counts as bound to its workspace root (`sessionRecordWorkspacePath`).

The task runs in the workspace's first folder: that is its `cwd` and `workspaceRoot`. While a task is
displayed, `SdkController.getWorkspaceRoot()` returns that folder rather than the window's, so mentions, file
reads, diff edits, slash commands and session rebuilds (mode switch, compaction, edit-and-regenerate) stay in
the conversation's workspace, and `ensureWorkspaceManager()` searches the workspace's folders. The override is
cleared with the task.

Starting in another workspace than the window's is only possible when its first folder exists; otherwise the
start fails with an error row asking for another workspace.

## Filtering history

`GetTaskHistoryRequest` takes `current_workspace_only` (the window's workspace) or `workspace_path` (one
workspace); with neither, every workspace is listed. The history view defaults to the current workspace and
offers **All workspaces** and the recent workspaces in a dropdown. The welcome page's **Recent** preview shows
only the current workspace's conversations. `TaskItem` and `HistoryItem` expose the binding, and labels show a
folder as `parent/folder` and a `.code-workspace` file by its name.

The other filters of the history view (favorites, search, date) and pinned conversations are described in
[conversation-history.md](conversation-history.md).

## Starting a conversation elsewhere

While no conversation is open, a **Start in** dropdown above the prompt box lists the window's workspace
(the default), the recently used ones, and **Choose folder…** / **Choose .code-workspace file…**, which open
the native picker (`WorkspaceService.pickWorkspace`). The choice travels as `NewTaskRequest.workspace_path`
and applies to that conversation only; the next one defaults to the window's workspace again.

## Recent workspaces

The last ten workspaces used to start a conversation, plus the workspace of every window opened, are kept in
`~/.cline/data/recent-workspaces.json` (`RecentWorkspacesStore`). The file is small, read on every request
and written atomically, so all windows share one list without a restart. It is deliberately not a
`StateManager` key: those are cached per window at startup.

## Several windows, one history

Conversations already live on disk under `~/.cline/data/sessions`, and every window lists that directory, so
they all see the same conversations. To notice the other windows' changes, `SdkTaskHistory.watchSessionChanges`
watches the directory (recursively where the platform allows it), drops the metadata cache and re-posts state
after a one-second quiet period. The history view reloads when the set of conversations, their titles or their
favorite or pin flags change in that state; usage totals ticking during a run do not trigger a reload.

The watcher also fires for this window's own writes. That is harmless: state posts are debounced, and the
cache is rebuilt at most about once a second while a task streams.
