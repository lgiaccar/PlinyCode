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

## Read-only tools run concurrently

`read_files`, `search_codebase`, `find_files` and `fetch_web_content` are marked `executionMode: "parallel"`. When a model asks for several of them in one response they overlap; a tool that changes something (`editor`, `run_commands`, MCP tools) still waits for the group before it and finishes before the next. Approvals are still asked one at a time, before anything runs.

The chat translator (`apps/vscode/src/sdk/message-translator/translator-state.ts`) keeps every open tool by call id for this, so each one finishes into its own row.

## Task list (`update_todo_list`)

An extension tool (`apps/vscode/src/sdk/vscode-todo-tool.ts`). The model sends the whole list each time, each task `pending`, `in_progress` or `completed`; the tool answers with the count and what is in progress or next. The chat shows the list after each update (`TodoListRow` in the webview, from a `task_progress` message).

- The tool keeps no state: the current list is the model's own last call.
- Input is read leniently: a markdown checklist in one string, bare strings, `task`/`title` for `content`, `done` for `completed`.
- After the context is compacted, the list survives only as far as the summary's next steps describe it; the model's next update writes it out in full again.
