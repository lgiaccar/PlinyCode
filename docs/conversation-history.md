# Conversation history: filters, favorites and pins

The history view lists past conversations. This page covers how the list is filtered and sorted, and how favorites and pins are stored. How conversations are bound to workspaces is in [workspace-conversations.md](workspace-conversations.md).

## Filters

The filters sit above the list and combine with each other:

| Filter | What it keeps |
| --- | --- |
| Search box | Conversations whose title or workspace path contains every word typed, in any case. |
| **Favorites** | Starred conversations only. |
| **Date** | Conversations active in the period: **Today**, **Last 7 days**, **Last 30 days**, or a **Custom range** with a from and a to date and time. |
| **Workspace** | The window's workspace (the default), all workspaces, or one recent workspace. |

A conversation runs from its start to its last activity. It is in a period when the two overlap, so a conversation started last week and continued today shows under **Today**.

**Clear filters** resets the search, the favorites toggle and the date. It leaves the workspace alone.

The sort menu next to the search box orders the list by newest, oldest, most expensive or most tokens. While a search is typed, **Most Relevant** ranks the loaded results by how well the title matches.

## Pins

The pin button on a row pins the conversation. Pinned conversations that match the current filters are listed first, in a **Pinned** section, in the chosen sort order. The rest follow under **Today** and **Older** (or **Others** for the sorts that are not by date). The **Recent** preview on the welcome page marks pinned conversations with a pin and keeps its order by recency.

A pin does not protect a conversation from being deleted. Favorites do: a starred conversation cannot be deleted from its row, and **Delete All History** offers to keep the favorites.

## How the list is built

The webview asks for one page at a time with `TaskService.getTaskHistory`. `GetTaskHistoryRequest` carries the filters (`favorites_only`, `search_query`, `from_ts`, `to_ts`, the workspace fields) and the sort.

`queryTaskHistory` in [task-history-query.ts](../apps/vscode/src/sdk/task-history-query.ts) filters the whole history, sorts it with the pinned conversations first, and only then is the result cut into pages. The order matters: the matches may all be older than the newest page. An earlier version paged first and filtered each page, so favorites older than the newest 50 conversations never showed.

The whole history is read from the metadata cache of `SdkTaskHistory`, without loading any messages.

## Where the flags are stored

Favorite and pin are fields in the session record's metadata: `isFavorited` and `isPinned`. They are changed only by `SdkTaskHistory.setTaskFavorite` and `setTaskPinned`, which the `toggleTaskFavorite` and `toggleTaskPin` RPCs call.

Every other write to a history record keeps the stored flags ([sdk-task-history.ts](../apps/vscode/src/sdk/sdk-task-history.ts), `updateSession`). Those writers hold a `HistoryItem` they read earlier, or build one from scratch at task start, and letting its flags through would un-star or unpin the conversation. Two flows start a new session for the same conversation, a checkpoint restore and an edit-and-regenerate; both copy the flags to the new record.

Starring or pinning a conversation writes its record, which updates its last-activity time.
