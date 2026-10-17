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

## Code intelligence (`find_symbol`, `code_navigate`, `rename_preview`)

Three extension tools that answer through the language servers running in the VS Code window, so the model navigates code instead of grepping for it. Code is in `apps/vscode/src/sdk/code-intel/` (the tools and their formatting, host-agnostic) and `apps/vscode/src/hosts/vscode/code-intel-source.ts` (the `vscode.execute*Provider` and call hierarchy commands, and `vscode.languages.getDiagnostics`). There are three tools with an `action` argument rather than one tool per question because free models mis-fill wide schemas.

- `find_symbol({ query?, path? })`: with `path`, the file's outline as an indented `kind name  line` list, filtered by `query` when both are given; without it, the workspace symbols matching `query` as `kind name  path:line:col`, at most 40.
- `code_navigate({ action, path, symbol?, line? })`: a question about a symbol as written in `path`. The tool finds the identifier in the file (the occurrence nearest to `line` when given), so the model never computes a column. `symbol` is required for every action except `diagnostics`; the schema lists only `action` and `path` as required and says so in the description.
  - `definition` and `references` come back grouped by file as `line:col  preview`, 30 lines at most, then `+N more in M files`.
  - `hover` is reduced to its code-fenced signature lines and a few lines of prose.
  - `callers` and `callees` prepare a call hierarchy at the position (`vscode.prepareCallHierarchy`) and ask the first item for one level of incoming or outgoing calls. Each entry is `kind name  path:line:col  preview`, at most 25, then `+N more`. A caller is shown at its first call site, so the preview is the line that makes the call; a callee is shown at its declaration, so the preview is its signature. When no hierarchy can be prepared (the server does not offer one, or the symbol is not a function) the answer suggests `references`.
  - `diagnostics` lists the errors and warnings the editor reports for the file, errors first, as `line:col  severity  message (source code)`, at most 20, then `+N more`. Information and hints are left out. An empty list is checked once more after the warm-up, since a file the editor has only just opened may not be analysed yet.
- `rename_preview({ path, symbol, new_name, line? })`: asks the rename provider (`vscode.executeDocumentRenameProvider`) at the symbol's position and summarizes the `WorkspaceEdit` it returns without applying it: ``Renaming `a` to `b` (at path:line:col) would make N edits in M files. Nothing was applied.``, then per file `path: N edits` and its first 3 changed lines as `  - line 12: old text → new text` (the current line with that line's edits applied), then `  +N more lines`; at most 20 files, then `+N more files`. When the server refuses (the position cannot be renamed, or no rename provider answered), the answer is ``Cannot rename `a` at path:line:col: <the server's reason>``. The model makes the edits itself afterwards.
- All three run in parallel with the other read tools and are auto-approved with them; sub-agents get them too. Their chat rows show the tool's answer.
- VS Code does not say whether a language server is registered for a file, so an empty answer is retried once after 1.5 s (a server that has just loaded the file may still be indexing), and a second empty answer ends with a line that sends the model to `search_codebase`. A file extension that answers nothing twice is not waited for again in that session. A rename refusal counts as an empty answer here, so it is asked twice too.
- Language servers only know files they have loaded: a workspace symbol search misses cold files, and a file outside the window's folders (a worktree, another repository) gets file-local answers at best.
- `plinycode.codeIntel.enabled` (default on) adds the tools to the next conversation; off removes them.

## Web search (`web_search`)

An extension tool that searches the public web and returns titles, URLs and snippets, so the model can look up documentation, error messages and release notes, then read the pages worth reading with `fetch_web_content`. Code is in `apps/vscode/src/sdk/web/` (the tool and the search backends, host-agnostic) and `apps/vscode/src/hosts/vscode/web-search-settings.ts` (settings, the API key, the command).

- `web_search({ query, site?, count? })`. `site` limits the search to one site (it becomes `site:<host>` in the query). `count` is 1 to 10, `plinycode.webSearch.maxResults` (default 8) when omitted.
- The answer is one block per hit, `n. Title — host`, then the URL and a snippet of at most 200 characters, each indented on its own line, and ends with `Read a page with fetch_web_content before relying on it.` No hits gives a line saying so and suggesting a rephrased query.
- It runs in parallel with the other read tools, is retried once on failure, and times out after 30 s (each HTTP request after 15 s). An HTTP error comes back as the engine's name, the status and the first 200 characters of the body.
- It is approved with `fetch_web_content`, under the **Use the browser** auto-approve toggle, and sub-agents get it too. The chat row shows the query and, expanded, the results.
- The engine's own `web_search` is a provider-native model tool (Anthropic's server-side search), which the Pliny gateway never offers. The extension's tool is added only when the session's provider has no native one, so an Anthropic-direct configuration keeps the native search.

| `plinycode.webSearch.provider` | What answers | Needs |
| --- | --- | --- |
| `duckduckgo-html` (default) | DuckDuckGo's script-free results page (`html.duckduckgo.com`), scraped | Nothing. It is a page, not an API: a markup change or a bot check breaks it, and a bot check is reported as an error that suggests another provider. |
| `searxng` | A SearXNG instance's JSON API (`<endpoint>/search?format=json`) | `plinycode.webSearch.endpoint`, and the `json` format enabled on the instance. Recommended for teams: one self-hosted instance, no key, no scraping. |
| `brave` | The Brave Search API | A subscription token. |
| `google-cse` | Google Programmable Search (Custom Search JSON API) | An API key, and the engine id in `plinycode.webSearch.googleCx`. |

- **API key.** Run **PlinyCode: Set Web Search API Key** (`cline.setWebSearchApiKey`), pick Brave or Google, and paste the key. It is kept in the editor's secret storage (the OS keychain), one per provider, never in settings; an empty value removes it. The key is read at search time, so a new one applies to running conversations.
- **On and off.** `plinycode.webSearch.enabled` (default on), which is also the **Web Search** switch in Settings → Features, adds the tool to the next conversation. The engine's flag for its native search follows the same setting, so one switch covers both.
- **Proxy.** Requests go through the extension's `fetch` (`apps/vscode/src/shared/net.ts`), the same proxy- and CA-aware one the Pliny gateway calls use.
- **Privacy.** The query leaves your network for the chosen provider, along with your IP address or the proxy's. Turn the setting off, or point it at a SearXNG instance you run, when that matters.

## Shell commands (`run_commands`)

With Terminal Execution Mode set to VS Code Terminal (the default), commands
run in a PlinyCode terminal, and the output is read through shell integration
(`VscodeTerminalProcess`).

- **Long-running commands.** A command still running after 5 minutes keeps
  running in the terminal. The call returns with the output so far and the
  path of a log file that receives the rest, and the command is registered
  as a background process (`p1`, `p2`, …; see below), so the model can
  read its log with `process_output` and stop it with `process_kill`. The
  same happens when the user clicks "Proceed While Running" or sends a
  message while the command runs. The tool description tells the model
  this, in place of the generic advice to background long jobs itself
  (`longRunningNote` on the engine's `createShellTool`). That way it runs a
  benchmark as an ordinary command and follows it with `wait`, instead of
  launching it with `Start-Process` and losing its output and errors.
- **`background: true`.** An optional argument for a server, watcher or
  other job the model does not want to wait for. The commands start as child
  processes of the extension host, in either terminal mode and in
  sub-agents, and the call returns at once with
  `Started <command> as process p3 (log: <path>). Use process_output to read it and process_kill to stop it.`
  Their output goes to the log file, not to a terminal. Without the argument
  nothing changes. A background process still running after 24 hours is
  stopped.
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

## Background processes (`process_list`, `process_output`, `process_kill`)

Commands that outlive their `run_commands` call: one handed over to the terminal while still running, and one started with `background: true`. The registry (`apps/vscode/src/sdk/processes/process-registry.ts`) is owned by `SdkController`, one per window, and gives each process a short id; the tools are in `process-tools.ts`.

- `process_list()`: this conversation's processes, one line each: `id  status  elapsed  command  log`. The status is `running`, `exited(<code>)` (or `exited` when no code was seen), `killed` or `lost` (PlinyCode can no longer observe a terminal command, which may still be running). The command is cut to 80 characters.
- `process_output({ id, tail_lines = 100 })`: a line on where the process stands (`p3 has been running for 4m02s: npm run dev`, `p3 exited with code 1 after 2m10s: …`), the log path and size, then the last lines of the log, at most 400 lines and 32 KB, with terminal colors removed. It always reads the log file, never the terminal buffer.
- `process_kill({ id })`: a terminal command gets Ctrl+C, and if it is still running 2 seconds later its terminal is closed; a child process is stopped with its whole process tree. A kill asked for before a handed-over command has its terminal is applied as soon as it starts.
- A model sees only its own conversation's processes. Sub-agents run under the root's session id, so they share the root's list.
- `process_list` and `process_output` run in parallel with the other read tools and follow the read-files approval toggle; `process_kill` follows the commands toggle. A CI board run may use all three on its own processes.
- The webview's background-command flag is set while a process of the displayed conversation is running, and the Cancel button and an interrupting message then call `cancelBackgroundCommand`, which stops every running process of that conversation.
- The registry lives in memory. After a window reload the list is empty and the terminals are gone (PlinyCode's terminals are transient), but the log files stay in the temp folder until its cleanup removes files older than 50 hours. Child processes are stopped when the window closes.

## Read-only tools run concurrently

`read_files`, `search_codebase`, `find_files`, `process_list`, `process_output`, `fetch_web_content` and `web_search` are marked `executionMode: "parallel"`. When a model asks for several of them in one response they overlap; a tool that changes something (`editor`, `run_commands`, MCP tools) still waits for the group before it and finishes before the next. Approvals are still asked one at a time, before anything runs.

The chat translator (`apps/vscode/src/sdk/message-translator/translator-state.ts`) keeps every open tool by call id for this, so each one finishes into its own row.

## Sub-agents (`spawn_agent`, `subagent_<name>`)

`spawn_agent` runs a sub-agent in its own context and returns only its final report to the model that called it. The engine's tool (`sdk/packages/core/src/extensions/tools/team/`) takes `task` and optional `instructions` (`systemPrompt` is the older name); configured agents from `.cline/agents/*.md` appear as `subagent_<name>` tools with a fixed prompt, model and tool allowlist. The system prompt carries a short section on when to delegate (`subagent-guidance.ts`, only while the tool is in the request): exploration across many files, reviews, long test runs, and independent subtasks that can run in parallel. The setting `subagentsEnabled` (Settings → Advanced) turns the tool off.

- **Prompt.** A sub-agent gets the same base prompt as a root session, with the conversation's git snapshot and pinned date, the session's mode (plan mode edits nothing), a short account of its role, the parent's instructions as rules, and a read-only excerpt of the repository's important memory entries (`subagent-prompts.ts`, `renderSubAgentMemoryExcerpt`). It knows nothing of the conversation itself: the parent's `task` is all it sees.
- **Tools.** The engine's built-ins plus the extension's own: `run_commands` (always in the background executor, so it cannot race the user's terminal), `wait`, the task list, the background process tools and MCP tools. Not the advisor, `save_memory` or the conversation search (`SUB_AGENT_DENIED_TOOLS` in `sdk-tool-policies.ts`), and not `spawn_agent` itself: delegation goes one level deep (`MAX_SUB_AGENT_DEPTH`).
- **Approval.** Delegating follows the **Delegate to sub-agents** auto-approve toggle (on by default). The sub-agent's own calls follow the same toggles and policies as the root's, since they edit the same files; an approval it asks for is preceded by a row saying which sub-agent asks.
- **Limits.** At most 3 sub-agent runs in flight per parent (the rest wait), 40 iterations per run unless the host sets `subAgentMaxIterations`, 20 minutes per run, and the same context compaction as the root session.
- **Cost.** The tool reports progress (`emitUpdate`) after each model call and tool: the sub-agents row shows tool calls, tokens and cost live. Its result carries the run's tokens, cache tokens and cost, which the `subagent_usage` row adds to the task header, the budget check and the history record; a task running in the background records them from the tool result. The chat shows nothing else of a sub-agent's work. In the engine, the progress reporter tags each of the sub-agent's events with its id and its parent's (`agentId`, `parentAgentId`), so its usage is counted as the sub-agent's and not the root agent's, and when the run ends, finished or failed, its totals are settled into the session's aggregate usage under its id (`settleSubAgentUsage` in `core/src/services/agent-events.ts`). A repeated end or a late event changes nothing, a turn that fails afterwards still writes the aggregate to the session metadata, and a resumed session reads it back as the floor of the usage it re-adds from the message files, so each run counts once.
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
