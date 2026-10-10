# Agent tools: editing, searching and keeping track

How the tools the model works with behave, where that differs from what a model would assume. The definitions are in `sdk/packages/core/src/extensions/tools/` (engine) and `apps/vscode/src/sdk/` (tools the extension adds).

## Editing (`editor`)

`old_text` has to identify one place in the file. Matching is in `executors/text-replace.ts` (`replaceTextInContent`), which both the executor and the VS Code diff preview call, so the preview shows what will be written.

| Situation | What happens |
| --- | --- |
| `old_text` occurs once | Replaced. |
| It occurs several times | Error listing the line of each occurrence. With `replace_all: true`, all are replaced and the result lists the lines. |
| It differs from the file only in indentation depth or trailing whitespace, and fits one place | Replaced. `new_text` is shifted by the same indentation, and the result says a whitespace-insensitive match was used. |
| The indentation differs in kind (tabs against spaces) or by a different amount per line | Not guessed at; treated as not found. |
| Not found | Error quoting the closest lines of the file, how many `old_text` lines are there, and the first line that differs. A whitespace-only difference is shown JSON-quoted so tabs and trailing spaces are visible. |

Small models often reproduce a block with the wrong indentation, or from a stale read. Before this the only feedback was "text not found", and the usual next move was the same call again.

## Searching file contents (`search_codebase`)

- Regex, case-insensitive. Each result shows the matching line, marked `>`, with two lines of context.
- `path` limits the search to a directory or a file; `glob` limits the file names (`*.ts`, `src/**/*.test.ts`, `!*.md`).
- A workspace search shows at most 10 matches per file and names the files that have more. A search with `path` set to a single file shows every match.
- The extension runs it with the ripgrep that VS Code ships. Without a ripgrep, a JavaScript scan reads every non-binary file under 2 MB.

## Finding files by name (`find_files`)

- A pattern with wildcards is a glob: `*.proto` matches by file name in any directory, `src/**/*.test.ts` matches from the workspace root. A pattern without wildcards matches any path that contains it (`router-policy`). Matching ignores case.
- `path` limits it to a directory. Up to 200 paths per pattern, sorted.
- Listed through ripgrep (which honors `.gitignore`) when one is available, otherwise by walking the directory and skipping dependency and build folders.
- It is enabled together with `search_codebase` (same `enableSearch` flag), and auto-approved with the other read tools. An agent file (`.cline/agents/*.md`) that allows `search_codebase` gets it too.

## Shell commands (`run_commands`)

With Terminal Execution Mode set to VS Code Terminal (the default), commands
run in a PlinyCode terminal, and the output is read through shell integration
(`VscodeTerminalProcess`).

- **Long-running commands.** A command still running after 5 minutes keeps
  running in the terminal. The call returns with the output so far and the
  path of a log file that receives the rest. The tool description tells the
  model this, in place of the generic advice to background long jobs itself
  (`longRunningNote` on the engine's `createShellTool`). That way it runs a
  benchmark as an ordinary command and follows it with `wait`, instead of
  launching it with `Start-Process` and losing its output and errors.
- **Wrapped lines.** On Windows the output passes through ConPTY. When a
  line wider than the terminal scrolls off the bottom row, ConPTY breaks it
  with `\r\n`, moves the cursor back to the end of the row and writes that
  row's last character again. `ConptyWrapJoiner` joins such rows back into
  one line before the output is split into lines, so a path comes back whole
  instead of as `…_2026100` / `06_124919`.
- **Narrow terminals.** Programs format to the terminal's width before
  PlinyCode sees their output: PowerShell tables lose columns and error
  messages break mid-word, and nothing afterwards can undo that. The VS Code
  API does not report a shell terminal's width, but a wrapped line shows it
  (the column ConPTY moves back to). Below 80 columns the result ends with a
  note telling the model the output was formatted to that width. The note
  also suggests `Out-String -Width 300` or writing to a file. The first time
  this happens in a window, the user is warned to widen the terminal panel or
  switch to Background Exec.

## Read-only tools run concurrently

`read_files`, `search_codebase`, `find_files` and `fetch_web_content` are marked `executionMode: "parallel"`. When a model asks for several of them in one response they overlap; a tool that changes something (`editor`, `run_commands`, MCP tools) still waits for the group before it and finishes before the next. Approvals are still asked one at a time, before anything runs.

The chat translator (`apps/vscode/src/sdk/message-translator/translator-state.ts`) keeps every open tool by call id for this, so each one finishes into its own row.

## Sub-agents (`spawn_agent`, `subagent_<name>`)

`spawn_agent` runs a sub-agent in its own context and returns only its final report to the model that called it. The engine's tool (`sdk/packages/core/src/extensions/tools/team/`) takes `task` and optional `instructions` (`systemPrompt` is the older name); configured agents from `.cline/agents/*.md` appear as `subagent_<name>` tools with a fixed prompt, model and tool allowlist. The system prompt carries a short section on when to delegate (`subagent-guidance.ts`, only while the tool is in the request): exploration across many files, reviews, long test runs, and independent subtasks that can run in parallel. The setting `subagentsEnabled` (Settings → Advanced) turns the tool off.

- **Prompt.** A sub-agent gets the same base prompt as a root session, with the conversation's git snapshot and pinned date, the session's mode (plan mode edits nothing), a short account of its role, the parent's instructions as rules, and a read-only excerpt of the repository's important memory entries (`subagent-prompts.ts`, `renderSubAgentMemoryExcerpt`). It knows nothing of the conversation itself: the parent's `task` is all it sees.
- **Tools.** The engine's built-ins plus the extension's own: `run_commands` (always in the background executor, so it cannot race the user's terminal), `wait`, the task list and MCP tools. Not the advisor, `save_memory` or the conversation search (`SUB_AGENT_DENIED_TOOLS` in `sdk-tool-policies.ts`), and not `spawn_agent` itself: delegation goes one level deep (`MAX_SUB_AGENT_DEPTH`).
- **Approval.** Delegating follows the **Delegate to sub-agents** auto-approve toggle (on by default). The sub-agent's own calls follow the same toggles and policies as the root's, since they edit the same files; an approval it asks for is preceded by a row saying which sub-agent asks.
- **Limits.** At most 3 sub-agent runs in flight per parent (the rest wait), 40 iterations per run unless the host sets `subAgentMaxIterations`, 20 minutes per run, and the same context compaction as the root session.
- **Cost.** The tool reports progress (`emitUpdate`) after each model call and tool: the sub-agents row shows tool calls, tokens and cost live. Its result carries the run's tokens, cache tokens and cost, which the `subagent_usage` row adds to the task header, the budget check and the history record; a task running in the background records them from the tool result. The chat shows nothing else of a sub-agent's work.
- **Routing.** On FreeAuto and BalanceAuto, a sub-agent run takes the `subagent` route and keeps its own call log and failover budget, keyed by the engine's agent id, so parallel sub-agents and the root never share one ([pliny-free-auto-router.md](pliny-free-auto-router.md)).

## Memory and earlier conversations (`save_memory`, `search_conversations`, `read_conversation`)

Extension tools described in [memory.md](memory.md). `save_memory` adds one entry to the repository's or the user's memory and is approved like a file edit. `search_conversations` and `read_conversation` search and read earlier conversations; they are approved like file reads and run concurrently.

## Slash commands that paste instructions

A workflow typed as `/name`, and a built-in command, is replaced in the user message by the file's body (`listAvailableRuntimeCommandsFromWatcher` in core's `runtime-commands.ts`, and `expandSlashCommands` in the extension). The body is cut at `MAX_COMMAND_INSTRUCTION_CHARS` (24,000 characters, twice a rule's budget) and ends with a note saying how many characters were left out and which file holds the rest, so a long file is read with `read_files` rather than pasted whole into every later request. Skills go through the `skills` tool instead and are not expanded.

## Task list (`update_todo_list`)

An extension tool (`apps/vscode/src/sdk/vscode-todo-tool.ts`). The model sends the whole list each time, each task `pending`, `in_progress` or `completed`; the tool answers with the count and what is in progress or next. The chat shows the list after each update (`TodoListRow` in the webview, from a `task_progress` message).

- The tool keeps no state: the current list is the model's own last call.
- Input is read leniently: a markdown checklist in one string, bare strings, `task`/`title` for `content`, `done` for `completed`.
- After the context is compacted, the list survives only as far as the summary's next steps describe it; the model's next update writes it out in full again.
