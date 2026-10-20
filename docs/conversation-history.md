# Conversation history: filters, favorites and pins

The history view lists past conversations. This page covers how the list is filtered and sorted, and how favorites and pins are stored. How conversations are bound to workspaces is in [workspace-conversations.md](workspace-conversations.md).

## Filters

The filters sit above the list and combine with each other:

| Filter | What it keeps |
| --- | --- |
| Search box | Conversations whose title or workspace path contains every word typed, in any case, then conversations whose messages match (see [Searching message text](#searching-message-text)). |
| **Favorites** | Starred conversations only. |
| **Date** | Conversations active in the period: **Today**, **Last 7 days**, **Last 30 days**, or a **Custom range** with a from and a to date and time. |
| **Workspace** | The window's workspace (the default), all workspaces, or one recent workspace. |

A conversation runs from its start to its last activity. It is in a period when the two overlap, so a conversation started last week and continued today shows under **Today**.

**Clear filters** resets the search, the favorites toggle and the date. It leaves the workspace alone.

The sort menu next to the search box orders the list by newest, oldest, most expensive or most tokens. While a search is typed, **Most Relevant** ranks the loaded title matches by how well the title matches, and lists the conversations found by their messages after them, best match first.

## Searching message text

A search also finds conversations by what was said in them, through the full-text index the `search_conversations` tool uses (SQLite FTS5, described in [memory.md](memory.md#searching-earlier-conversations)):

- **Title matches first.** Conversations whose title or path matches come first. The ones found only by their messages follow, each with the text that matched under its title (the matched words in brackets). Under **Most Relevant** they keep the index's order; under the other sorts they follow that sort.
- **The other filters still apply.** Favorites, date and workspace filter the content matches as they do the rest. With a folder selected, the index query is narrowed to that folder; a `.code-workspace` is filtered after the query.
- **Words, not substrings.** The index matches whole words and word prefixes (`frob` finds `frobnicator`), every word typed. The title search keeps matching any substring.
- **Limits.** At most 200 conversations are found by their messages per search. The index covers the most recently active conversations within its caps (20,000 conversations or a 200 MB database), and is refreshed every 5 minutes, so a conversation from the last few minutes is found by its title only until then. The search does not wait for a refresh, since it runs as you type.
- **First use.** The index is built when it is first needed: by the first search here or the first `search_conversations` call in a window. The first build reads every transcript in the background, and searches made meanwhile find what it has indexed so far.
- **Without SQLite or FTS5**, the search matches titles and paths only, as before.

## Pins

The pin button on a row pins the conversation. Pinned conversations that match the current filters are listed first, in a **Pinned** section, in the chosen sort order. The rest follow under **Today** and **Older** (or **Others** for the sorts that are not by date). The **Recent** preview on the welcome page marks pinned conversations with a pin and keeps its order by recency.

A pin does not protect a conversation from being deleted. Favorites do: a starred conversation cannot be deleted from its row, and **Delete All History** offers to keep the favorites.

## How the list is built

The webview asks for one page at a time with `TaskService.getTaskHistory`. `GetTaskHistoryRequest` carries the filters (`favorites_only`, `search_query`, `from_ts`, `to_ts`, the workspace fields) and the sort.

`queryTaskHistory` in [task-history-query.ts](../apps/vscode/src/sdk/task-history-query.ts) filters the whole history, sorts it with the pinned conversations first, and only then is the result cut into pages. The order matters: the matches may all be older than the newest page. An earlier version paged first and filtered each page, so favorites older than the newest 50 conversations never showed.

With a search, `queryTaskHistoryWithContent` appends the content matches from `ConversationSearch.searchContent` ([conversation-search.ts](../apps/vscode/src/sdk/memory/conversation-search.ts)) before paging, and each of them carries `TaskItem.match_snippet`. Title matches have an empty snippet, which is how the webview tells the two apart.

The whole history is read from the metadata cache of `SdkTaskHistory`, without loading any messages; only the content search reads the index.

## Where the flags are stored

Favorite and pin are fields in the session record's metadata: `isFavorited` and `isPinned`. They are changed only by `SdkTaskHistory.setTaskFavorite` and `setTaskPinned`, which the `toggleTaskFavorite` and `toggleTaskPin` RPCs call.

Every other write to a history record keeps the stored flags ([sdk-task-history.ts](../apps/vscode/src/sdk/sdk-task-history.ts), `updateSession`). Those writers hold a `HistoryItem` they read earlier, or build one from scratch at task start, and letting its flags through would un-star or unpin the conversation. Two flows start a new session for the same conversation, a checkpoint restore and an edit-and-regenerate; both copy the flags to the new record.

Starring or pinning a conversation writes its record, which updates its last-activity time.

## Titles and references

A new conversation starts with the first line of its prompt as title. A moment later a small free model (the router rules' `commit` utility model, one request with the first 2,000 characters of the prompt) replaces it with a title of 3 to 7 words ([conversation-title.ts](../apps/vscode/src/sdk/conversation-title.ts)). The title is stored like a rename, so restarting from an edited message keeps it. A title you set yourself while the model works is never replaced, and a failed call leaves the first-line title. Conversations started with a title of their own (CI board runs, background starts) are not renamed.

Each conversation also shows a short reference, such as `#ab3dx`, in the history list and the task header. It is the random part of the conversation id ([conversationRef.ts](../apps/vscode/src/shared/conversationRef.ts)), so it names the conversation in a message or a bug report and matches the id in `traces/` and the session folder.
