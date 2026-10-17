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

## Code intelligence (`find_symbol`, `code_navigate`, `rename_preview`, `rename_symbol`)

Four extension tools that answer through the language servers running in the VS Code window, so the model navigates code instead of grepping for it, and renames a symbol in one call instead of editing each use. Code is in `apps/vscode/src/sdk/code-intel/` (the tools and their formatting, host-agnostic) and `apps/vscode/src/hosts/vscode/code-intel-source.ts` (the `vscode.execute*Provider` and call hierarchy commands, `vscode.languages.getDiagnostics` and `vscode.workspace.applyEdit`). The questions share one tool with an `action` argument rather than one tool per question because free models mis-fill wide schemas.

- `find_symbol({ query?, path? })`: with `path`, the file's outline as an indented `kind name  line` list, filtered by `query` when both are given; without it, the workspace symbols matching `query` as `kind name  path:line:col`, at most 40.
- `code_navigate({ action, path?, symbol?, line? })`: a question about a symbol as written in `path`. The tool finds the identifier in the file (the occurrence nearest to `line` when given), so the model never computes a column. `path` is required for every action except `diagnostics`, and `symbol` for every action except `diagnostics`; the schema lists only `action` as required and says so in the descriptions.
  - `definition` and `references` come back grouped by file as `line:col  preview`, 30 lines at most, then `+N more in M files`.
  - `hover` is reduced to its code-fenced signature lines and a few lines of prose.
  - `callers` and `callees` prepare a call hierarchy at the position (`vscode.prepareCallHierarchy`) and ask the first item for one level of incoming or outgoing calls. Each entry is `kind name  path:line:col  preview`, at most 25, then `+N more`. A caller is shown at its first call site, so the preview is the line that makes the call; a callee is shown at its declaration, so the preview is its signature. When no hierarchy can be prepared (the server does not offer one, or the symbol is not a function) the answer suggests `references`.
  - `diagnostics` with `path` lists the errors and warnings the editor reports for the file, errors first, as `line:col  severity  message (source code)`, at most 20, then `+N more`. Information and hints are left out. An empty list is checked once more after the warm-up, since a file the editor has only just opened may not be analysed yet.
  - `diagnostics` without `path` lists the errors (not warnings) the editor reports across the window, grouped by file. The header is `N errors in M files across the workspace (warnings left out):`; then each file as `path (N errors)` with its first 5 errors indented under it in the per-file format and `  +N more`, the files with the most errors first (ties in path order), at most 10 files, then `+N more files with M errors`. Files under `node_modules`, `.git` and PlinyCode's data directories are left out, as in the cross-file check of [edit-problems.md](edit-problems.md). An empty list says that only files a language server or linter has checked report errors (the open files, and for TypeScript the files of open projects) and suggests passing `path`.
- `rename_preview({ path, symbol, new_name, line? })`: asks the rename provider (`vscode.executeDocumentRenameProvider`) at the symbol's position and summarizes the `WorkspaceEdit` it returns without applying it: ``Renaming `a` to `b` (at path:line:col) would make N edits in M files. Nothing was applied.``, then per file `path: N edits` and its first 3 changed lines as `  - line 12: old text → new text` (the current line with that line's edits applied), then `  +N more lines`; at most 20 files, then `+N more files`. When the server refuses (the position cannot be renamed, or no rename provider answered), the answer is ``Cannot rename `a` at path:line:col: <the server's reason>``.
- `rename_symbol({ path, symbol, new_name, line? })`: the same position and the same edits, applied. It is described below.
- `find_symbol`, `code_navigate` and `rename_preview` run in parallel with the other read tools and are auto-approved with them; sub-agents get them too. Their chat rows show the tool's answer.
- VS Code does not say whether a language server is registered for a file, so an empty answer is retried once after 1.5 s (a server that has just loaded the file may still be indexing), and a second empty answer ends with a line that sends the model to `search_codebase`. A file extension that answers nothing twice is not waited for again in that session. A rename refusal counts as an empty answer here, so it is asked twice too.
- Language servers only know files they have loaded: a workspace symbol search misses cold files, and a file outside the window's folders (a worktree, another repository) gets file-local answers at best.
- `plinycode.codeIntel.enabled` (default on) adds the tools to the next conversation; off removes them.

### Renaming (`rename_symbol`)

`rename_symbol` is the one code intelligence tool that writes. It resolves the position like `rename_preview` and asks for the same edits, then asks the rename provider once more and applies the server's whole `WorkspaceEdit` with `vscode.workspace.applyEdit`, file operations included (a server that renames a class's file with the class does both), and saves every file the edit changed.

- **Approval.** It is in the edit group (`EDIT_TOOLS` in [sdk-tool-policies.ts](../apps/vscode/src/sdk/sdk-tool-policies.ts)), so it follows the **Edit files** auto-approve toggle. The approval shows the summary `rename_preview` would give, worked out while the ask is built (`describeToolApproval` in [sdk-interaction-coordinator.ts](../apps/vscode/src/sdk/sdk-interaction-coordinator.ts), `describeRenameForApproval` in the tool's module): ``Renaming `a` to `b` (at path:line:col) will make N edits in M files and save them.``, then the per-file lines. A server that takes more than 10 s gets the plain ask instead. The chat row is `renameSymbol`: "PlinyCode wants to rename `a` to `b` in path and every file that uses it" while it waits, "PlinyCode renamed …" afterwards, with the summary or the result in the accordion.
- **Order.** It runs sequentially (`executionMode: "sequential"`), never alongside another tool call, and times out after 60 s.
- **Result.** ``Renamed `a` to `b` (at path:line:col): N edits in M files, saved.``, then the preview's per-file lines (taken before the edit, so `old → new` still reads right). A file that could not be saved gets `Could not save path: the rename is in the editor only there.`, and a file that already had unsaved changes in the editor gets `path had unsaved changes in the editor, which were saved with the rename.`
- **New problems.** The rename runs inside the same check the edit tools use ([edit-problems.md](edit-problems.md)): `SdkDiffEditCoordinator.beginExternalEditCheck` records the errors of every file the preview lists, and of every other file, before the edit, and the report of new errors in those files and in the importers is appended to the result.
- **Failures.** A refusal, no answer, an edit the editor did not apply (a file changed under it or is read-only) and a second answer with no edits fail the call with the reason and `Nothing was changed.`, so it does not count as an edit.
- **Modes.** Plan and ask mode do not get the tool (the session's mode leaves it out of `createCodeIntelTools`), and the engine's mode guards reject it anyway: [plan-mode.md](plan-mode.md) and [ask-mode.md](ask-mode.md). So does the guard of an off-the-record side question ([side-questions.md](side-questions.md)).
- **Checkpoints.** The checkpoint of a run is a snapshot of the whole working tree (tracked and untracked files) taken by the engine's checkpoint hook when the run starts, not a record of each edit tool's writes. The rename saves its files before the tool returns, so "Restart and revert files" and "View changes" see it like any other edit; the reviewer pass counts it as an edit and reads it from the checkpoint diff. Without checkpoints (not a git repository) the reviewer's fallback, which rebuilds changes from `editor` and `apply_patch` inputs, has nothing to show for a rename.
- **CI Board runs** have no rule for it: an attended run asks, an unattended one refuses, since a language server's rename can reach files outside the run's worktree.

### `@` mention file search

The `@` menu in the chat input asks the host for candidate files (`searchWorkspaceItems` in [workspace.proto](../apps/vscode/proto/host/workspace.proto)) and ranks them with fzf in [file-search.ts](../apps/vscode/src/services/search/file-search.ts). The VS Code host answers from its own file index ([searchWorkspaceItems.ts](../apps/vscode/src/hosts/vscode/hostbridge/workspace/searchWorkspaceItems.ts)), so typing after `@` no longer walks the workspace with ripgrep:

- The text after the query's last `/` becomes a fuzzy, case-blind glob on file names (`chrow` → `**/*[cC]*[hH]*[rR]*[oO]*[wW]*`) for `vscode.workspace.findFiles`, plus `**/<glob>/**` to find folders whose names match. fzf also matches across directories (`chat/row`), which one glob cannot, so fewer than 50 name matches are topped up with a plain listing for fzf to rank. An empty query lists files.
- `files.exclude` and `search.exclude` both apply, joined into one exclude glob (brace groups expanded, entries with a `when` condition skipped). Ignore files such as `.gitignore` do not: `findFiles` does not read them.
- A query that looks like an identifier (three characters or more) also asks the language servers for workspace symbols (`vscode.executeWorkspaceSymbolProvider`, at most 1.5 s). The files declaring classes, interfaces, functions, enums, structs, modules, namespaces or constants whose names contain the query come first, labelled `path (Symbol)`, so `@ChatRowProps` offers the file that declares it.
- Each `findFiles` call is cancelled after 5 s. When the index finds nothing in time, or fails, the caller falls back to ripgrep. A directory outside the window's folders (a conversation in a worktree) is answered with gRPC's UNIMPLEMENTED code, which sends the caller to ripgrep without a warning in the log.

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

`read_files`, `search_codebase`, `find_files`, `find_symbol`, `code_navigate`, `rename_preview`, `process_list`, `process_output`, `fetch_web_content` and `web_search` are marked `executionMode: "parallel"`. When a model asks for several of them in one response they overlap; a tool that changes something (`editor`, `rename_symbol`, `run_commands`, MCP tools) still waits for the group before it and finishes before the next. Approvals are still asked one at a time, before anything runs.

The chat translator (`apps/vscode/src/sdk/message-translator/translator-state.ts`) keeps every open tool by call id for this, so each one finishes into its own row.

## Sub-agents (`spawn_agent`, `subagent_<name>`)

`spawn_agent` runs a sub-agent in its own context and returns only its final report to the model that called it. The engine's tool (`sdk/packages/core/src/extensions/tools/team/`) takes `task` and optional `instructions` (`systemPrompt` is the older name); configured agents from `.cline/agents/*.md` appear as `subagent_<name>` tools with a fixed prompt, model and tool allowlist. The system prompt carries a short section on when to delegate (`subagent-guidance.ts`, only while the tool is in the request): exploration across many files, reviews, long test runs, and independent subtasks that can run in parallel. The setting `subagentsEnabled` (Settings → Advanced) turns the tool off.

- **Prompt.** A sub-agent gets the same base prompt as a root session, with the conversation's git snapshot and pinned date, the session's mode (plan mode edits nothing), a short account of its role, the parent's instructions as rules, and a read-only excerpt of the repository's important memory entries (`subagent-prompts.ts`, `renderSubAgentMemoryExcerpt`). It knows nothing of the conversation itself: the parent's `task` is all it sees.
- **Tools.** The engine's built-ins plus the extension's own: `run_commands` (always in the background executor, so it cannot race the user's terminal), `wait`, the task list, the background process tools and MCP tools. Not the advisor, `save_memory` or the conversation search (`SUB_AGENT_DENIED_TOOLS` in `sdk-tool-policies.ts`). Whether it gets `spawn_agent` depends on the depth limit below: at the default depth of 1 it does not; at 2 the root's sub-agents get it and theirs do not, and the root's `spawn_agent` description says which. Configured agents never get `spawn_agent`.
- **Approval.** Delegating follows the **Delegate to sub-agents** auto-approve toggle (on by default), at every level. The sub-agent's own calls follow the same toggles and policies as the root's, since they edit the same files; an approval it asks for is preceded by a row saying which sub-agent asks (a second-level sub-agent's row does not name it).
- **Limits.** Three settings, read when a conversation starts (`plinycode.subagents.*`, passed to the engine as `CoreSessionConfig.subAgentLimits`; `sub-agent-limits.ts` holds the defaults):
  - `maxDepth` (default 1, at most 2): levels of sub-agents below the root. The engine caps it at 2 whatever the host asks.
  - `maxConcurrent` (default 3, 1 to 6): sub-agent runs one parent has in flight; further calls wait for a slot. The limit is per parent, so at depth 2 one root can have up to `maxConcurrent + maxConcurrent²` runs at once (12 at the defaults).
  - `maxIterations` (default 40, 5 to 200): model calls per run. A configured agent's own `maxIterations` takes precedence; one without uses this setting.

  Each run also stops after 20 minutes and gets the same context compaction as the root session. Every running sub-agent makes its own model calls, so raising depth or concurrency raises what one delegation can cost, and on a paid model it reaches the conversation's budget sooner.
- **Cost.** The tool reports progress (`emitUpdate`) after each model call and tool: the sub-agents row shows tool calls, tokens and cost live. Its result carries the run's tokens, cache tokens and cost, which the `subagent_usage` row adds to the task header, the budget check and the history record; a task running in the background records them from the tool result. A sub-agent's result includes what the sub-agents it started used (`spawnAgentOutputFromResult`'s `nested` figures), so at depth 2 the root pays for the whole tree. The sub-agent's own usage events stay out of the root's figures; its work is shown in its transcript (below). In the engine, the progress reporter tags each of the sub-agent's events with its id and its parent's (`agentId`, `parentAgentId`), so its usage is counted as the sub-agent's and not the root agent's, and when the run ends, finished or failed, its own totals are settled into the session's aggregate usage under its id (`settleSubAgentUsage` in `core/src/services/agent-events.ts`). The settled figure leaves out the runs it delegated, which settle their own, so a nested run is not counted twice. A repeated end or a late event changes nothing, a turn that fails afterwards still writes the aggregate to the session metadata, and a resumed session reads it back as the floor of the usage it re-adds from the message files, so each run counts once.
- **Transcript.** Each item of the sub-agents row has a chevron that opens the sub-agent's transcript under it: its text, reasoning, tool and command rows as the main chat would show them, compact and indented, following the newest rows while it works. None of it enters the main chat. The translator files every event that carries a `parentAgentId` (or names a sub-agent it already knows) under the event's `agentId` and translates it against a translator state of its own (`message-translator/subagent-transcripts.ts`), so concurrent sub-agents never share a streaming row with each other or with the root, and the root's own tools keep showing while a sub-agent runs. A transcript leaves out asks: an approval a sub-agent needs is still asked in the main chat as before, and a failed request shows as an error row without Retry. Expanding an item opens `TaskService.subscribeToSubagentMessages`, which sends what is kept and then each added or changed message; collapsing it cancels the stream.
  - **Limits.** The last 300 messages per sub-agent, and the 20 most recent sub-agents per conversation; older ones are dropped, oldest first.
  - **Depth 2.** A second-level sub-agent has a transcript of its own. Its parent's transcript holds the parent's own sub-agents row, with a chevron per item, so it opens nested under its parent rather than in the root's list.
  - **Naming.** The spawn tool reports the sub-agent's id in a progress update as soon as the run is created, so the chevron is there before the first model call ends.
  - **Live only.** Transcripts are kept in memory while the conversation is open in this window and dropped when another conversation is opened or this one is cleared or resumed from history. A reopened conversation shows the sub-agent's final report as before; its chevron then says there is no transcript to show.
- **Configured agents.** Markdown files with YAML frontmatter (`name`, `description`, and optionally `tools`, `skills`, `providerId`, `modelId`, `maxIterations`) and the agent's prompt as the body, in the workspace's `.cline/agents/` or the global agents folder (`~/.cline/agents/`, or `$CLINE_DIR/agents`). `.yml` and `.yaml` files load too. A workspace agent hides a global one of the same name. The Rules panel's **Agents** tab lists them with their tool name, description, model and path; a file that does not parse is listed with the reason. Each has a switch: a switched-off agent's tool gets a tool policy with `enabled: false` when the next conversation starts (`withDisabledAgentPolicies` in `configured-agents.ts`), which the engine's runtime builder removes from the request. The switches are stored by file path in `localAgentToggles` (workspace) and `globalAgentToggles`. **New agent** writes `<name>.md` from a template with `name` and `description` filled in and every optional field commented out with what leaving it out means, then opens it. Each enabled agent adds a tool, with its description, to every request.
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
