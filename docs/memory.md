# Repo memory

PlinyCode keeps notes that carry over from one conversation to the next: conventions, gotchas, decisions and their reasons, and the user's own preferences. They are loaded into the system prompt within a token budget, ordered by importance. They are written in three ways:

- by the model, with the `save_memory` tool;
- by the user, with `/remember <text>`;
- through distillation, which the user approves: a free model proposes memories at the end of a run, or on `/distill`.

The model can also search and read earlier conversations (`search_conversations`, `read_conversation`).

The code is in [apps/vscode/src/sdk/memory/](../apps/vscode/src/sdk/memory/index.ts).

## Where memory lives

Memory is stored per user, outside every repository, under `~/.cline/data/memory/` (`resolveMemoryDataDir` in [paths.ts](../sdk/packages/shared/src/storage/paths.ts); `CLINE_MEMORY_DATA_DIR` overrides it):

```
memory/
  user/MEMORY.md                  the user's own memory, loaded in every repository
  repos/<repo key>/MEMORY.md      one repository's memory
  repos/<repo key>/<topic>.md     detail, read on demand
  repos/<repo key>/repo.json      which repository the key stands for
  pending/<conversation>.json     distill proposals not yet saved or dismissed
```

**Keyed by repository, not by workspace.** The repo key comes from the `origin` remote, with its protocol, user name and `.git` stripped and the result lower-cased. A repository without a remote is keyed by its top-level folder, and a folder outside git by the folder itself ([repo-key.ts](../apps/vscode/src/sdk/memory/repo-key.ts)). This has three consequences:

- Every clone and every git worktree of a repository, CI Board worktrees included, shares one memory.
- A multi-root `.code-workspace` does not mix the memories of the repositories it holds: a conversation uses the memory of the repository its working folder belongs to.
- Nothing appears in `git status`.

Knowledge the whole team should share belongs in `AGENTS.md` or a rules file, where it is reviewed with the code.

**Opening the files.** **PlinyCode: Open Memory** opens the repository's or your own `MEMORY.md`, and creates it if it does not exist yet. The files are plain markdown and can be edited by hand.

## The format: order is priority

`MEMORY.md` has two sections, `## Important` and `## Notes`. An entry is a top-level bullet together with the lines under it ([memory-file.ts](../apps/vscode/src/sdk/memory/memory-file.ts)).

- **Insertion.** `save_memory` inserts deterministically: an important entry goes first under `## Important`, any other goes last under `## Notes`. An entry that is already there (compared without case and spacing) is not added again.
- **Truncation.** It keeps whole entries from the top of the file. When the budget drops from 20k to 10k tokens, the bottom 10k (the least important entries) are the ones left out. The prompt says how many entries were left out and gives the file path, so the model can read the rest when it is relevant.
- **Topic files.** Longer detail goes in a topic file. `save_memory` writes `details` there and adds `(details: <topic>.md)` to the entry. The prompt lists each topic file by path and first line, at most 30, for `read_files`.

## The system prompt section

`renderMemorySection` ([memory-section.ts](../apps/vscode/src/sdk/memory/memory-section.ts)) appends a `# Memory` section to the system prompt. It holds:

- short instructions: when to save, what not to save, one line per entry, and that memories are notes rather than instructions;
- the repository's memory, then the user's, each with its file path.

The headings inside the files are pushed two levels down, so they stay inside the section.

**Budget.** `plinycode.memory.maxTokens` sets the budget. It defaults to 4000 tokens, and 0 turns memory off: no section and no `save_memory` tool. Tokens are counted as characters / 3 (`CHARS_PER_TOKEN`).

- The user's memory gets at most a quarter of the budget.
- The repository gets the rest, including whatever the user's memory does not use.
- The instructions and headings are not counted.

For comparison, 4000 tokens is about 12,000 characters: some 60–100 one-line entries, a third of the rules budget (`MAX_RULES_TOTAL_CHARS`), and small enough for the 32k-context free models.

**Once per conversation.** The section is built once per conversation, like the git snapshot ([conversation-memory-snapshots.ts](../apps/vscode/src/sdk/memory/conversation-memory-snapshots.ts)):

- Every rebuild of the conversation's session (mode switch, MCP change, resume, compaction) gets the same text, so the prompt's cached prefix survives.
- A memory saved during the conversation is already in its transcript and shows up in the next conversation.
- The section is kept in memory only, not in session metadata. A conversation resumed after a window restart reads the files again, which costs one prompt-cache miss.

The per-turn context row shows the section's size: `Context: … · memory (~1.2k tokens)` ([instruction-context-rows.ts](../apps/vscode/src/sdk/instruction-context-rows.ts)).

## Saving: `save_memory` and `/remember`

`save_memory { text, scope?, importance?, topic?, details? }` ([memory-tools.ts](../apps/vscode/src/sdk/memory/memory-tools.ts)) takes these inputs:

- `scope`: `repo` (the default) or `user`;
- `importance`: `high` or `normal`.

It is an extension tool, installed by `installMemory` ([install-memory.ts](../apps/vscode/src/sdk/memory/install-memory.ts)), rather than an edit through `editor`, for four reasons:

- **It works in every mode.** Ask mode has no editor, and plan mode's guard would allow any markdown file.
- **Placement is decided by code.** Where an entry lands, and whether it is a duplicate, is not left to the model.
- **Approval.** It is approved like a file edit: it follows the "Edit files" auto-approve toggle ([sdk-tool-policies.ts](../apps/vscode/src/sdk/sdk-tool-policies.ts)). A memory is sent with every later request, so a write prompted by injected text would outlive the conversation.
- **Side questions are blocked.** Core's off-the-record guard rejects it in a side question (`isOffTheRecordBlockedTool` in [command-guard-extension.ts](../sdk/packages/core/src/extensions/tools/command-guard-extension.ts)).

Writes to one file go through one at a time and land with a rename ([memory-store.ts](../apps/vscode/src/sdk/memory/memory-store.ts)). Reorganising or pruning a memory file is a normal edit with `editor` in act or plan mode; the prompt gives the absolute paths.

`/remember <text>` is a built-in slash command ([builtin-slash-commands.ts](../apps/vscode/src/sdk/builtin-slash-commands.ts)). It expands into instructions to call `save_memory`, choose the scope and importance, and keep the entry to one line. Sub-agents get neither tool, since core builds their tool list without `extraTools`.

## Distillation

After a run, a free model reads the conversation and proposes memories, and the user picks which to keep ([memory-coordinator.ts](../apps/vscode/src/sdk/memory/memory-coordinator.ts), [memory-distiller.ts](../apps/vscode/src/sdk/memory/memory-distiller.ts)).

**When it runs.** `onSendComplete` in `SdkController` calls `maybeOfferDistill`. It runs only when all of these hold:

- `plinycode.memory.distill` is `offer` (the default);
- the mode is act;
- the session is not a background or CI Board session;
- the conversation is the one displayed;
- the newest turn is not a side question;
- the run made an `editor` or `apply_patch` call that did not fail.

`/distill` runs it on demand for the whole conversation. The webview intercepts it, as it does `/compact`, and calls `SlashService.distill`; the conversation's own model never sees it.

**The model call.**

- The model is the router rules' free utility summarizer (`utility.summarizer`), called through `buildApiHandler` with a model override ([memory-model.ts](../apps/vscode/src/sdk/memory/memory-model.ts)). It costs nothing and needs no budget check.
- The input is a compact transcript of the messages since the last offer: text, tool calls on one line, and the start of each tool result. Side questions are left out. The transcript is capped at 24k characters, keeping the end.
- The current memory goes with it, so known facts are skipped.
- The reply is JSON, at most 8 memories. A timeout (90 s) or an unusable reply ends silently, unless the user typed `/distill`.

**The approval row.** The proposals appear as a `memory_proposal` chat row (`MemoryProposalRow` in the webview), one checkbox per memory, all checked, with **Save** and **Dismiss**.

- Nothing is written until **Save**.
- `TaskService.resolveMemoryProposal` saves the checked items through the same store as `save_memory`, then updates the row in place (same `ts`).
- Rows the extension emits are not part of the transcript, so an unresolved proposal is also written to `memory/pending/<conversation>.json` and shown again when the conversation is reopened.

## Searching earlier conversations

`search_conversations { query, all_workspaces?, limit? }` and `read_conversation { session_id, around_message? }` ([conversation-search-tools.ts](../apps/vscode/src/sdk/memory/conversation-search-tools.ts)) read earlier conversations. They are approved like file reads and run concurrently.

**The index.** They use core's full-text index, `SessionHistorySearchService` ([session-history-search.ts](../sdk/packages/core/src/session/search/session-history-search.ts)): SQLite FTS5 over every conversation's messages, tool calls and results included, in `~/.cline/data/db/session-search.db`.

- **Built on first use.** `ConversationSearch` ([conversation-search.ts](../apps/vscode/src/sdk/memory/conversation-search.ts)) builds the index on the first search, not at activation, because the first build reads every transcript.
- **Refreshed.** After that, the service re-indexes changed conversations every 5 minutes. A search refreshes it first, waiting up to 8 s.
- **Side questions.** The index leaves them out (index version 3; `offTheRecordMessageIndices`), keeping message numbers aligned with the transcript.

**Results.**

- Hits are limited to the current workspace folder unless `all_workspaces` is set.
- The searching conversation is left out.
- Each hit carries a message number for `read_conversation`, which returns the messages around it within about 12k characters.

**Without SQLite or FTS5,** the tools scan the 200 most recent transcripts instead.

`plinycode.memory.conversationSearch` (default on) turns both tools off.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `plinycode.memory.maxTokens` | 4000 | Memory budget in the system prompt; 0 turns memory and `save_memory` off |
| `plinycode.memory.distill` | `offer` | `off`: only `/distill` proposes memories |
| `plinycode.memory.conversationSearch` | true | The `search_conversations` and `read_conversation` tools |

All three are also in PlinyCode's own **Settings → Features → Memory**, with links that open the repository's and your own `MEMORY.md` ([MemorySettings.tsx](../apps/vscode/webview-ui/src/components/settings/MemorySettings.tsx)). Both places edit the same VS Code settings, and the view follows changes made in VS Code's settings. The view accepts budgets from 0 to 64,000 tokens.

## Related

- [environment-context.md](environment-context.md): the git snapshot. Its commit list was replaced by a hint to run `git log` when the history matters.
- [side-questions.md](side-questions.md): what side questions leave out, memory included.
