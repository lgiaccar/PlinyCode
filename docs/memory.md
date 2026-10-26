# Repo memory

PlinyCode keeps conventions, gotchas, decisions and preferences across conversations. Important entries form a stable system-prompt section. Relevant notes are retrieved into the first user message; `recall_memory` can find more during a task. Current user instructions take precedence over remembered notes.

The implementation is in [apps/vscode/src/sdk/memory/](../apps/vscode/src/sdk/memory/index.ts).

## Where memory lives

Memory stays outside repositories under `~/.cline/data/memory/` (`CLINE_MEMORY_DATA_DIR` overrides it):

```text
user/MEMORY.md                    personal preferences and machine facts
repos/<key>/MEMORY.md             one repository's entries
repos/<key>/repo.json             repository identity, aliases, group override
groups/<key>/MEMORY.md            organization or ADO project entries
{user,repos/<key>,groups/<key>}/<topic>.md   longer explanations
{user,repos/<key>,groups/<key>}/usage.json   retrieval dates and counts
pending/<conversation>.json       proposals awaiting review or Undo
distill/<conversation>.json       distillation position, dismissals, save count
```

Repository keys use the normalized origin remote, falling back to the git top-level folder or working folder. Clones and worktrees share one memory. Multi-root workspaces use the repository of the conversation's working folder.

Groups are derived automatically from the remote prefix: `github.com/org/repo` uses `github.com/org`; `dev.azure.com/org/project/_git/repo` uses `dev.azure.com/org/project`. ADO collection/project paths work the same way. Set `"group": "custom/prefix"` in `repo.json` to override this, or `"group": false` to disable it. A folder without a remote has no automatic group. The files are rendered in repository, group, user order.

When the host of an origin remote changes, the Memory panel offers **Adopt memory from …** for a saved remote with the same path. Adoption requires the new repository memory to be empty, preserves the old files, and adds the new remote identity to `repo.json`'s `aliases` array. Future clones on either host use that memory.

**PlinyCode: Open Memory** opens repository, group or personal memory. The files are plain Markdown and can be edited by hand.

## Entry format and types

`MEMORY.md` has `## Important` and `## Notes` sections. New entries go first in their section. Entries have tolerant, optional metadata:

```markdown
- Always link Release gtest libraries for Debug builds. <!-- added:2026-10-17 used:2026-10-23 pinned type:gotcha -->
```

`added` records creation, `used` records a repeated save or an explicit keep during cleanup, and `pinned` prevents cleanup proposals. Older `last_used:` comments are still understood. Metadata is omitted from model text. Retrieval dates and counts live in `usage.json`; loading the stable system tier does not count as retrieval or rewrite Markdown.

| Type | Example | Usual scope |
| --- | --- | --- |
| `convention` | PRs target stage | repo |
| `gotcha` | Conan Debug needs Release gtest libraries | repo or group |
| `decision` | Chose simpler thresholds, with reason and date | repo |
| `environment` | Use powershell.exe on this machine | user |
| `preference` | Keep answers brief | user |
| `reference` | A model catalog URL | repo or user |

Untyped existing entries remain valid. A typed user preference is eligible for the stable tier regardless of importance; legacy untyped Important user entries stay eligible too. Pinned entries are eligible in every scope.

Near duplicates use Jaccard similarity of significant words at 0.7 or the same first six significant words. Negations are preserved, so a memory and its negation remain distinct. Saving checks all applicable scopes, keeps an existing duplicate in its original scope, bumps its date and returns that file. Details are attached there too. Cleanup can propose older cross-scope duplicates for removal.

## Budget and retrieval

`plinycode.memory.enabled` (default on) is the master switch for loading memory into the prompt, the `save_memory` and `recall_memory` tools, `/remember` and `/forget`, and distillation (`/distill` and automatic offers). Turn it off in Settings → Features → Memory while keeping your `MEMORY.md` files editable. Past-conversation search stays on its own setting.

`plinycode.memory.maxTokens` accepts a token count, a percentage such as `4%`, or `auto`. The default is `auto`: the smaller of 4000 tokens and 4% of the selected model's context window (1280 tokens for a 32k window). Explicit numeric settings remain supported. `0` also disables automatic loading and memory tools when memory is enabled. Text estimates use characters / 3.

[selectMemories](../apps/vscode/src/sdk/memory/memory-retrieval.ts) keeps whole entries within one budget, including instructions and wrapper text:

1. The stable tier holds repository and group Important entries, pinned entries, and user preferences. It is captured once per conversation to preserve the cached system prefix.
2. The remaining budget holds notes selected with BM25 over the small local entry set. The query uses the first user message, editor state included in the request, and paths in the git snapshot. Relevance ranks first, then pin/importance, retrieval count and recency. If nothing matches, file order is the fallback.

The user scope gets at most `userShare` percent (25 by default). Selection is frozen after the first request and appended as a `<relevant_memories>` text block to the first user message. It does not alter the cached system section. A reload captures memory again, and turning memory on during a conversation captures it on the next session rebuild. A changed budget, including switching to a smaller model, rebuilds the selection from the captured entries so it respects the new limit.

`recall_memory { query }` searches repository, group and personal entries mid-task and returns up to ten matches, their source files and topic pointers. It follows file-read approval. Retrieval records usage once per conversation and entry; the stable prefix alone does not bump it. Sub-agents receive only a read-only Important excerpt, at most 2000 characters, and cannot use memory tools.

Click **Memory** in the context breakdown, or open **What reached this conversation** in the Memory panel, to see the actual stable section, retrieved block, token estimate and omitted entries in grey. A `memory` record in the [session trace](trace-and-logs.md) lists entry IDs, their tiers, omitted IDs, the budget and estimated tokens. The diagnostics bundle includes that trace.

## Saving: save_memory, /remember and /forget

`save_memory { text, scope?, type?, importance?, topic?, details?, force?, replace?, remove? }` saves one entry. It follows the file-edit approval setting in every conversation mode.

- `scope`: repository (`repo`, the default), organization/project (`group`), or personal/machine (`user`).
- `importance`: `high` requests Important; `normal` requests Notes. The rule heuristic can demote High, never promote Normal. Important is capped at 15 per scope by default.
- `details` and `topic`: longer Markdown stored in a topic file, referenced from the entry. Index entries fit in 600 characters; oversized tool saves retain their full text in details.
- `replace: true`: correct a near duplicate in place, preserving its creation date and topic pointer.
- `remove: true`: remove a matching memory after confirming which entry the user meant. Exact prune proposals remain protected against intervening text edits.
- `force: true`: only for wording the user explicitly requested with `/remember`; bypasses the change-log gate and save cap.

The quality gate refuses change logs, facts derivable from code, and task narration dressed as rules, including “When resolving merge conflicts between a branch …” and “When instrumenting Triangulate() in SurfaceTetMesh.cxx …”. Do not save secrets, task state, signatures or line numbers.

The model can save at most eight new entries per conversation by default. The counter is kept in `distill/<conversation>.json`, shared by tool saves and approved distillation proposals, and survives window reloads. Cross-scope repeats do not consume another save.

`/remember <text>` asks the model to choose a type, scope and importance and save it. `/forget <text>` searches for a near match, quotes it for confirmation and then removes it with `save_memory`. Both explain that memory is unavailable when it is disabled.

## Distillation

A free utility model proposes up to four memories. Agent runs qualify after a successful edit. Plan and Ask runs qualify without an edit and focus on decisions, their reasons and preferences. Background runs and off-the-record side questions do not distill. `/distill` requests a proposal manually.

The model is asked to aim for 200 characters; complete entries up to 600 characters are retained. Longer entries keep the full text in `details`, shown in the proposal row and saved to a topic file. No trailing fact is silently discarded.

The default `distill: offer` requires review. `distill: off` leaves only `/distill`. Opt-in `distill: auto` immediately saves Normal proposals and shows an **Undo** action; Important proposals and all removals still need review. Undo removes only the exact saved wording and leaves a changed entry alone.

The chat row remains, and unresolved proposals also appear in the Memory inbox with a badge and a **Review** banner in the next conversation in the repository. Inbox actions operate on the original proposal, including after a reload. Existing pending proposals are reviewed before another one replaces them. Pending records expire after 30 days. Deleted conversations' old pending/distill files are pruned when history is available, with a one-day grace period; a missing or empty history deletes nothing.

**Clean up memory now** finds candidates without calling the distillation model: change logs, within/cross-scope duplicates, Notes not used for the configured stale age, and orphan topic files. Pinned and recently kept entries are protected; Important and undated entries are not removed for age. Retrieval usage delays stale proposals. Entries are removed only after review, and only if their wording still matches. Keeping a proposed removal bumps its date.

## Editing and promotion

**Settings → Features → Memory** groups entries by scope and section, with filtering, text editing, delete, pin, scope move, importance and type controls. Dates and retrieval counts are visible. Moving an entry copies its topic details before removing the source.

**Promote to AGENTS.md**, also available on a saved proposal row, opens an editable Markdown draft based on the nearest `AGENTS.md`. Review and save it to the displayed path. **Finish promotion** checks the saved file contains the convention before removing it from memory. This keeps team conventions in a file reviewed with the repository.

## Searching earlier conversations

`search_conversations { query, all_workspaces?, limit? }` and `read_conversation { session_id, around_message? }` ([conversation-search-tools.ts](../apps/vscode/src/sdk/memory/conversation-search-tools.ts)) read earlier conversations. They are approved like file reads and run concurrently.

**The index.** They use core's full-text index, `SessionHistorySearchService` ([session-history-search.ts](../sdk/packages/core/src/session/search/session-history-search.ts)): SQLite FTS5 over every conversation's messages, tool calls and results included, in `~/.cline/data/db/session-search.db`.

- **Built on first use.** `ConversationSearch` ([conversation-search.ts](../apps/vscode/src/sdk/memory/conversation-search.ts)) builds the index on the first search, not at activation, because the first build reads every transcript.
- **Refreshed.** After that, the service re-indexes changed conversations every 5 minutes. A search refreshes it first, waiting up to 8 s.
- **Side questions.** The index leaves them out (`offTheRecordMessageIndices`), keeping message numbers aligned with the transcript.
- **Editor state.** The `<editor_state>` and `<mode_notice>` blocks the extension adds to typed messages are left out of the index and of what `read_conversation` returns, so an open file's name does not match a search (index version 4).
- **Workspace roots** are stored normalized (forward slashes, no trailing slash, lower case on Windows), and the folder filter runs in the index query, so another workspace's conversations cannot crowd this one's out of the candidates.
- **Size caps.** The index holds the most recently active conversations (by last activity, so an old conversation continued today counts as recent), at most 20,000 of them and at most 200 MB of live database pages, and drops the least recently active first. When the database outgrows 200 MB, it is compacted first, since deleted rows only leave the file then; if it is still over, the number of conversations is lowered so the index fills 90% of the cap, and raised again in proportion once it is below 60%. The history listing the index reads from currently returns at most 2,000 conversations (`MAX_HISTORY_SCAN_LIMIT` in core's [history.ts](../sdk/packages/core/src/runtime/host/history.ts)), so in practice that is the cap until the listing is widened.
- **Compaction.** FTS5 `optimize` followed by `VACUUM` runs after evictions (deleted conversations, or ones beyond a cap) that removed at least 500 indexed messages and at least 10% of the index, and otherwise at most once a week when anything was removed or re-indexed since the last one. Both block the extension host while they run. When another window holds the database, the attempt is retried an hour later. The counters and the last compaction time are kept in the database (`search_meta`), so all windows share them.
- **The history view** searches message text through the same index ([conversation-history.md](conversation-history.md#searching-message-text)), without waiting for a refresh.

**Results.**

- Hits are limited to the current workspace folder unless `all_workspaces` is set.
- The searching conversation is left out.
- Each hit carries a message number for `read_conversation`, which returns the messages around it within about 12k characters.

**Without SQLite or FTS5,** the tools scan the 200 most recent transcripts instead.

`plinycode.memory.conversationSearch` (default on) turns both tools off. It does not turn off the history view's content search, which builds the same index on its first search.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `plinycode.memory.enabled` | true | Load memory, memory tools, slash saves and distillation |
| `plinycode.memory.maxTokens` | `auto` | Tokens, percentage or adaptive budget; 0 disables memory when enabled |
| `plinycode.memory.distill` | `offer` | Review proposals, opt-in `auto` with Undo, or `off` |
| `plinycode.memory.conversationSearch` | true | Search/read previous conversations |
| `plinycode.memory.userShare` | 25 | Personal memory's maximum percentage of the budget |
| `plinycode.memory.importantCap` | 15 | Important entries per scope before model saves are demoted |
| `plinycode.memory.saveCap` | 8 | New model saves per conversation |
| `plinycode.memory.staleDays` | 90 | Age without use before a Notes entry becomes a cleanup candidate |
| `plinycode.memory.proposalCount` | 4 | Maximum proposals per distillation |

The limits are under **Advanced** in the Memory panel, beside per-scope counts and the captured token/omission report. Both the panel and VS Code settings update the same values.

## Related

- [environment-context.md](environment-context.md): git snapshots and editor state.
- [side-questions.md](side-questions.md): side questions stay out of distillation.
- [trace-and-logs.md](trace-and-logs.md): trace records and diagnostics.
