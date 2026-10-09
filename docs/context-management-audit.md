# Context management audit

An audit of PlinyCode against what an AI IDE needs to keep a long task from degrading: sub-agents, task isolation, context compression, persistent memory and project knowledge. Done on 2026-10-09 against `stage` at `a92b68d`. Each finding was read in the code; the sites named are where to look. The fixes are being landed in waves, in the order below, and a finding is marked with the wave that addresses it or **open** when none does yet.

The waves:

1. correctness bugs and quick wins (this document's PR);
2. per-session task isolation;
3. sub-agents;
4. compaction robustness and the context UI;
5. memory, search and knowledge.

## Ranked summary

| # | Finding | Impact | Wave |
| --- | --- | --- | --- |
| 1 | Sub-agents in the extension have no shell, `wait`, task list or MCP tools: core builds their tools from the built-ins only, the built-in shell is suppressed in favour of the extension's `run_commands`, which lives in `extraTools` | sub-agents can read and edit but not run anything | 3 |
| 2 | Sub-agent cost is lost: core aggregates it into the session record, the extension never reads it, the `subagent_usage` row sums a cost that is always 0, and configured `subagent_<name>` agents get no row at all | paid sub-agent spend is invisible to the task header, the budget check and history | 3 |
| 3 | A sub-agent's system prompt is only the text the parent model wrote: no environment block, working directory, date, git snapshot or memory; nothing in the system prompt tells the model when to delegate | weak, inconsistent sub-agents | 3 |
| 4 | The mode, the workspace root and the side-question flag were controller-wide: a background CI Board task's `read_files` resolved relative paths against the displayed task's workspace, every session's router read the global mode, and the CI Board flipped it, which rebuilt and cancelled the turn of the task still displayed | wrong files read, wrong routing, surprises for the user | 2 |
| 5 | Agentic compaction did nothing when the over-budget content was the latest typed turn: it never cuts before the latest prompt, returned nothing, and nothing fell back to basic compaction or checked the result against the target. Basic compaction now runs when agentic declines (nothing new to fold, or a summarizer that answered with no text), which is also where a summary that left the request over the trigger lands on the next call, and the chat says when one message alone is too large ([context-compaction.md](context-compaction.md)) | the request went out until the provider rejected it; one overflow recovery per run, then the run ended | 4 |
| 6 | Routed sessions (FreeAuto, BalanceAuto) forced compaction on even when auto-condense was off | setting ignored | 1 |
| 7 | `save_memory` appended normal notes at the end of `## Notes` while the budget keeps the top of the file, so a new note was the first thing cut and the tool still said later conversations would see it | memory silently lost | 1 |
| 8 | The system prompt's date was filled from the clock on every rebuild, changing the cached prefix on the first rebuild of each day; the git snapshot and the memory section are pinned for exactly this reason | one prompt-cache miss per conversation per day | 1 |
| 9 | The past-conversation search snippet's ellipsis was the mojibake literal `â€¦` | every search result | 1 |
| 10 | Images were counted as text at three characters per token: a 1 MB screenshot estimated at about 350k tokens. Binary payloads now count at `IMAGE_TOKEN_ESTIMATE` (1,600 tokens) in every estimate | needless compaction; the output-token clamp was dropped | 4 |
| 11 | The context breakdown's rules bucket was always 0 (`contextSources` was never set); the context bar divides by the advertised window while compaction fires at 90% of the input limit (FreeAuto: ~83k of 256k, so the bar shows about a third); the threshold marker was never passed. The engine now passes the composed rules as request metadata, and the bar draws the marker. Skills and workflows buckets are still 0 | the UI misled about when compaction happens | 4 |
| 12 | The router's per-run state (`activeTurnKey`, `recoveringRootRun`, `turnEdits`) was one closure; parallel sub-agents overwrote it, and a root failure after a sub-agent run benched the sub-agent's model. Runs are now keyed by the engine's agent id, which the model factory and `onRunError` carry | wrong model benched, wrong failover budget | 3 |
| 13 | Nested `AGENTS.md` files (this repository's own `apps/vscode/AGENTS.md`, `sdk/AGENTS.md`) and `CLAUDE.md` are never loaded; always-on rules are inlined in alphabetical order under the 40k budget Fixed: nested `AGENTS.md` and `CLAUDE.md` are listed by path and scoped to their folder, and the workspace `AGENTS.md` is inlined first ([rules.md](rules.md)). | the model misses the guides written for it | 5 |
| 14 | The transcript was rewritten whole, synchronously, pretty-printed and with the system prompt, after every model call | I/O grows with the square of the conversation length | 1 |
| 15 | Skills and workflows typed as slash commands were pasted into the message with no size cap | a long file takes the context with it | 1 |
| 16 | Sub-agents get no compaction, no iteration cap, no concurrency cap, unbounded recursion, and a `timeoutMs` the loop never enforces | runaway cost and context | 3 |
| 17 | Sub-agents run with no tool approvals: `spawn_agent` is not in the policy map, and the spawned agent gets no policies or approval callback | a sub-agent edits and runs without the user's toggles | 3 |
| 18 | The summarizer's own tokens and cost were never recorded; they now come back with the compaction result and show as a usage row with `source: "compaction"`, rebuilt from the summary message on reopen | cost invisible | 4 |
| 19 | The prompt-cache breakpoint goes on the newest user or assistant text block; in a tool loop with no assistant text every tool result since is sent uncached. `PLINYCODE_CACHE_MARK_TOOL_CALLS=1` marks tool-call messages with a one-character text, for measuring | cache misses | 4 (probe) |
| 20 | Conversation search: the workspace filter is applied after the query on a bounded candidate list, so another workspace can crowd out hits; `<editor_state>` blocks are indexed and returned; the index evicts everything older than the 1000 most recent conversations Fixed: roots are normalized and filtered in the index query, editor-state blocks are left out; the 1000-conversation cap remains. | misses, noise | 5 |
| 21 | Distillation keeps its progress in memory only (proposals repeat after a reload, dismissed ones are not remembered), saves under the displayed workspace rather than the session's, and drops a proposal that is a substring of any existing entry Fixed: progress and dismissed memories are stored per conversation, and proposals are compared as whole entries. The proposal is still saved under the displayed task's folder, which is the conversation's own since wave 2. | | 5 |
| 22 | Memory budget: the instruction block, the "N more entries" notes and the topic lists are not counted; the chat's context row estimates at four characters per token while the budget uses three Fixed: the instructions, topic lists (12 per memory) and the note come out of the budget, and the context row uses three characters per token. | the section can exceed the budget | 5 |
| 23 | Two VS Code windows saving memory at once can lose an entry: writes are queued per process only Fixed: a best-effort lock file orders writes across windows. | rare | 5 |
| 24 | Checkpoints stash the whole working tree of the folder; two tasks in the same folder (foreground plus background, or parallel sub-agents) share it, and the reviewer's diff includes the other task's changes | limitation | 2 (warning) |
| 25 | No code knowledge base: no symbol index, repo map or embeddings; `list_code_definition_names` is an alias of `search_codebase` The cheapest step is taken: nested agent guides now reach the model; a symbol index is not built. | the model discovers code by regex and file reads only | 5 (cheapest step) |

## Context compression

Where: `sdk/packages/core/src/extensions/context/` (`compaction.ts`, `agentic-compaction.ts`, `basic-compaction.ts`, `compaction-shared.ts`, `budget-projection/`), `sdk/packages/shared/src/llms/tokens.ts`, `sdk/packages/llms/src/providers/`.

- **Trigger.** Compaction runs when the estimated request (system prompt, messages, tools, at three characters per token) exceeds 90% of the model's input limit. Pliny catalog models set the input limit to the context window; FreeAuto uses a 92k budget, BalanceAuto 128k. The budget is scaled down when the provider reported more input tokens than the estimate, up to four times.
- **Agentic strategy** keeps about 20k tokens of recent messages, never cuts inside a tool call and result pair, and never before the latest typed prompt. A summary replaces what it cut. When nothing new can be folded it returns nothing, and only a thrown error falls back to the basic strategy (finding 5).
- **Basic strategy** keeps every typed prompt, folds older turns to their final answer, and can trim inside the latest turn.
- **Overflow recovery.** A provider that rejects the request gets one basic compaction and retry per run, only if the request got smaller.
- **Tool results** are capped per tool (48k characters for commands, reads and searches; 50k for web fetches) and again by the message builder (50k per string, 64k per result). Superseded file reads become `[outdated - see the latest file content]`. Images over 5 MB each or 8 MB in total are replaced, newest first.
- **Caching.** Only catalog models flagged for it get cache breakpoints: the end of the system prompt and the newest user or assistant text (finding 19). The prefix is changed by a mode switch, a rules file edit (rules are re-read on every run), prior-turn reasoning removal, outdated-read rewrites, compaction, an MCP tool change, and until this wave the date (finding 8).
- **The display** reads the last request's usage against the advertised window (finding 11).

## Sub-agents and task isolation

Where: `sdk/packages/core/src/extensions/tools/team/`, `sdk/packages/core/src/runtime/host/local/spawn-tool.ts`, `apps/vscode/src/sdk/vscode-session-host.ts`, `apps/vscode/src/sdk/message-translator/live-events.ts`, `apps/vscode/src/sdk/router/router-integration.ts`, `apps/vscode/src/sdk/SdkController.ts`, `apps/vscode/src/sdk/sdk-session-config-builder.ts`.

- `spawn_agent` is on by default (`subagentsEnabled`). Before wave 3 the parent model wrote the whole system prompt and the task; the engine ran a fresh session with the parent's hooks, no history, built-in tools only, and returned the final text with token counts but no cost. Parallel calls ran under `Promise.all` with no cap; recursion was unbounded. Wave 3 gave sub-agents the base prompt with environment, mode, snapshot, date and a memory excerpt, the extension's tools, the session's policies and approval, compaction, a depth of one, three concurrent runs, 40 iterations and 20 minutes per run, live progress and a priced result ([agent-tools.md](agent-tools.md), "Sub-agents").
- Configured agents (`.cline/agents/*.md`, `subagent_<name>`) are the same mechanism with a fixed prompt, model and tool allowlist.
- `ask_advisor`, the FreeAuto classifier, the completion judge and the reviewer pass are single tool-free requests. Only the advisor records its cost.
- Side questions, restart-from-here and CI Board worktrees are the isolation that exists. The CI Board is the only thing that gives a run its own working tree.
- Controller-wide state read by every session before wave 2: the global mode, the displayed task's workspace root (used by the `read_files` executor), the side-question flag. Wave 2 made the router's mode the session's own (`SessionConfigInput.mode`, captured at build), the side-question flag per session, `read_files` resolve against the session's `cwd` inside the engine, and the CI Board build its run in act mode without moving the mode switch. Still controller-wide, by design: one translator state and interaction coordinator (only the displayed task has chat rows), the diff-edit preview and memory distillation (both only run for the displayed task), and the spending-limit check (only runs for the foreground session).

## Persistent memory and knowledge

Where: `apps/vscode/src/sdk/memory/`, `sdk/packages/core/src/session/search/`, `sdk/packages/core/src/extensions/config/`, `sdk/packages/core/src/runtime/safety/rules.ts`.

- Memory is keyed by repository, loaded once per conversation within `plinycode.memory.maxTokens`, and written by `save_memory`, `/remember` and distillation. Dedupe is exact-match only; there are no timestamps, expiry or pruning.
- Past-conversation search is SQLite FTS5 over every message, built on first use, refreshed every five minutes, limited to the 1000 most recent conversations.
- Rules: the root `AGENTS.md`, `.clinerules`, `.cline/rules`, the running editor's own rule folders, and one global folder. Always-on rules are inlined up to 12k characters each and 40k in total, sorted by name; scoped rules are listed by path. Rules are re-read on every run.
- Skills are listed by name and description in the `skills` tool and loaded when called. Nothing indexes the code.

## Storage

Transcripts live in `~/.cline/data/sessions/<id>/<id>.messages.json` (finding 14), the search index in `~/.cline/data/db/session-search.db` (never vacuumed), memory under `~/.cline/data/memory/` (topic files and `pending/` proposals are never pruned).
