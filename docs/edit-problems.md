# New problems after an edit

When the `editor` or `apply_patch` tool writes a file, the tool result the model receives also lists the errors VS Code reports for that file that were not there before the edit. The model learns about a type or syntax error it introduced in the same turn, without the user mentioning `@problems`.

```
Edited src/a.ts
...
New problems reported in this file after the edit (fix them if your change caused them):
- line 12: Cannot find name 'foo'. (ts 2304)
```

A patch that touches several files lists the problems under each file's path. Nothing is appended when the edit adds no error, and nothing changes in the chat: the edit row renders from the tool input, not from its result.

Errors the edit causes in files it did not touch, such as the importers of a renamed export, come under a second heading:

```
New problems reported in other files after this edit (fix them if your change caused them):
src/b.ts
- line 1: Module '"./a"' has no exported member 'foo'. (ts 2305)
src/c.ts
- line 4: Module '"./a"' has no exported member 'foo'. (ts 2305)
```

The setting `plinycode.edits.reportNewProblems` (default on) turns it off.

## What is reported

- Errors only. Warnings, information and hints are left out.
- Only errors that are new. The file's errors are read before the write and compared with those after it. An error is identified by its source, code and message, not its line, so an error the edit only moved is not reported again; a second copy of an existing error is.
- At most 10 per file, each with its one-based line, message, and source and code when the diagnostic has them, then "and N more". Messages are put on one line and clipped at 300 characters.
- At most 10 files per edit.
- For other files, at most 5 files of at most 5 errors each, then "and N more files". Files are named relative to the working directory the edit's paths are relative to, with forward slashes, or by their absolute path when they are outside it, and listed in path order.

## Where it lives

- [edit-problems.ts](../apps/vscode/src/sdk/edit-problems.ts): `EditProblemsReporter`, which records the errors before an edit, waits after it and formats the report. It sees the editor only through the `EditDiagnosticsSource` interface.
- [edit-diagnostics.ts](../apps/vscode/src/hosts/vscode/edit-diagnostics.ts): the VS Code implementation of that interface (`languages.getDiagnostics` for one file and for the whole window, `onDidChangeDiagnostics`, the open documents and tabs) and the setting.
- [sdk-diff-edit-coordinator.ts](../apps/vscode/src/sdk/sdk-diff-edit-coordinator.ts): `executeEditorTool` and `executeApplyPatchTool` start a check before the disk write and append the report to the executor's result. `SdkController` passes the VS Code source in when it builds the coordinator.

## Waiting for the language server

A language server analyses a file some time after it changes, so the reporter waits for VS Code's diagnostics-changed event for the file:

- up to 1.5 s for the first event;
- then until no event has arrived for 300 ms, since servers often publish twice (syntax, then types);
- never more than 3 s in all.

The wait starts once the preview has closed and the edited file is shown, when the server analyses it. For a file that already had a tab, the 1.5 s count from the write, so the auto-approve preview linger usually covers it. The tool call's abort signal ends the wait at once, with nothing appended.

Measured in VS Code 1.139: the TypeScript server answers 0.5 to 0.9 s after the write, the JSON server about 0.2 s after.

Two details of VS Code shape the wait:

- **Stale events.** Right after a write to a file open in a tab, VS Code re-publishes the file's old diagnostics, before the editor has reloaded the file. The reporter counts an event only once the document's version has moved past its version before the write.
- **Silence.** A server publishes nothing when a file had no problems and still has none (TypeScript does this), and a file type with no language server never publishes. Such an edit costs the full 1.5 s. Per window, the reporter remembers each file extension that has ever produced a diagnostics event; an extension that stayed silent through two waits without ever producing one is no longer waited for, so a `.txt` or `.md` edit costs nothing after the first two. An event for that extension at any later time turns the wait back on.

A server that answers after the wait has ended is not lost: the file is remembered, and errors that arrive within a minute are reported with the next edit, under "New problems reported in files you edited earlier".

## Headless edits

With Background Edit on, or for a task running in the background, the edited file is not shown. VS Code's TypeScript and JSON servers analyse only a document that is loaded and has a tab: `workspace.openTextDocument` alone produces no diagnostics, and neither does a tab whose document is not loaded. So for the check, the reporter loads the document and opens it in a background tab (`vscode.open` with `background: true`), which does not take the focus or change the visible editor, and closes the tab again once the report is made. When the editor area is empty, that tab is briefly the visible one. Once the tab closes, VS Code stops analysing the file, so the reporter keeps the errors it saw as the baseline for the file's next edit.

## Other files

An edit can break files it does not touch: renaming or removing an export breaks every importer, and changing a type breaks its users. To catch these, the reporter also records the errors of every file in the window before the write (`languages.getDiagnostics()` with no URI, errors only, `file:` URIs only, leaving out files under `node_modules`, `.git`, the extension's global storage, where checkpoints keep copies of workspace files, and `~/.cline`). Once the edited files have settled, it reads them again and reports, in files other than the edited ones, the errors that were not in the snapshot, with the same identity rule as for the edited files. The section is capped at 5 files of 5 errors each.

The wait is the edited files' wait: events for other files do not count as the edited file's answer, do not extend the quiet period, and are not waited for when the edited file's type is one that stays silent. The section holds whatever the language servers had published by the time the edited files settled. A file whose late answer is reported under "files you edited earlier" is not repeated here.

If the window-wide diagnostics cannot be read before the edit, other files are left out of that edit's report and the edited files are reported as usual.

## Failure handling

The report never fails, blocks or changes an edit. Any error while reading diagnostics or showing a file leaves the executor's result as it is, and a failed write fails as before.

## Limitations

- An edit that leaves a TypeScript file in a tab without errors waits the full 1.5 s, unless the auto-approve linger already covered it.
- If VS Code misses the write to a file open in a tab (seen for a file outside the workspace that is rewritten right after its tab opens), the document is never reloaded and the edit reports nothing.
- Other files are reported only as far as their language server re-checks them. VS Code's TypeScript server re-checks the files it has loaded: open tabs, files touched recently and project files it has already parsed, so a broken export shows up in loaded importers and not in cold ones, and only if the server publishes them within the edited file's wait. Other language servers vary. The full picture still needs a build or `@problems` after the edit.
- A file with unsaved changes in its tab is not reloaded from disk, so its diagnostics describe the unsaved text.
