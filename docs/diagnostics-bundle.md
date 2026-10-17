# Diagnostics bundle

When a run goes wrong, the chat row shows one error and the rest is spread
over the Output channel, the data folder and the editor's settings. **PlinyCode:
Export Diagnostics Bundle** gathers it into one folder you can attach to a bug
report. It is in the Command Palette, in **Settings → About → Diagnostics**,
and under every error row in the chat (**Export diagnostics**).

The code is `apps/vscode/src/hosts/vscode/diagnostics-bundle.ts` (reads the
editor and the controller, reveals the folder) over
`apps/vscode/src/sdk/diagnostics/diagnostics-bundle.ts` (collects and writes,
no VS Code API) and `redact.ts` (what is removed). The webview reaches the
command through the `exportDiagnostics` RPC of `UiService`.

## Where it goes

`<dataDir>/diagnostics/<yyyyMMdd-HHmmss>/`, where `<dataDir>` is PlinyCode's
data folder: `~/.cline/data` unless `CLINE_DATA_DIR` or `CLINE_DIR` says
otherwise, the same folder as the router's `pliny-free-auto-calls.jsonl`. The
folder is revealed in the file manager when it is written, and the
notification's **Open folder** button opens it again. Bundles are never deleted
by PlinyCode; remove the ones you no longer need.

No archive is made. Zip the folder yourself if you need one file.

## What is in it

| File                            | Contents                                                                                                                                                                                                                                 | When it is missing                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                     | What the bundle holds, what was not available and why, and the reminder to check it before sharing.                                                                                                                                      | Always written.                                                                                                                                 |
| `versions.json`                 | PlinyCode's version and extension id, the editor's name and version (`vscode.env.appName`, `vscode.version`), UI kind, remote name, display language, OS platform and release, architecture, Node and Electron versions. No hostname, no user name. | Always written.                                                                                                                                 |
| `settings.json`                 | `editor`: the effective value of every `plinycode.*` setting the extension declares. `global`: `StateManager`'s global state and settings. `workspace`: its workspace state (rules toggles). All redacted as below.                      | Always written. Without an initialised `StateManager`, `global` holds a note instead.                                                            |
| `last-model-request.txt`        | The JSON of **Show Last Model Request** for the displayed conversation ([restart-from-here.md](restart-from-here.md)): system prompt, messages after compaction, tools.                                                                   | Always written; it reads `not captured` when the conversation has not sent a request since the window opened, or no conversation is displayed.   |
| `router/pliny-*-auto*.md`       | Every routing rules file in the data folder: `pliny-free-auto.md`, `pliny-free-auto.<profile>.md`, `pliny-balance-auto.md` ([pliny-free-auto-router.md](pliny-free-auto-router.md)).                                                      | No rules file written yet.                                                                                                                      |
| `router/pliny-free-auto-calls.jsonl`, `router/pliny-free-auto-runs.jsonl` | The last 500 lines of each router log.                                                                                                                                                                                       | The log does not exist yet (it appears once an auto-free or auto-paid-balanced model handles a request).                                         |
| `trace/<sessionId>.jsonl`       | The displayed conversation's trace, copied from `<dataDir>/traces/`. A file over 20 MB is cut to its last 20 MB, starting on a whole line.                                                                                               | No conversation displayed, or no trace file for it. Traces are written by builds that have session tracing; older builds have no `traces/` folder. |
| `logs/plinycode.log`, `logs/plinycode.1.log` | The current log file and the newest rotated one, from `<dataDir>/logs/`.                                                                                                                                                      | No log file (builds without it keep this window's lines in the PlinyCode Output channel only), or the log has not rotated yet.                    |
| `mcp-settings.json`             | The MCP settings file McpHub reads (`<dataDir>/settings/cline_mcp_settings.json`), redacted as below.                                                                                                                                     | The file does not exist, or it is not valid JSON: an unparseable file is left out rather than written unredacted, and the README gives the parse error. |
| `ci-board.json`                 | The CI Board's store (`<dataDir>/ci-board.json`, [ci-board.md](ci-board.md)), redacted as below.                                                                                                                                         | The board has never been used.                                                                                                                  |
| `conversation.md`               | The displayed conversation as **Export Conversation as Markdown** renders it, tool output included, reasoning left out.                                                                                                                   | No conversation displayed, or the conversation is not in the history yet.                                                                        |

The bundle is written even when most of these are missing; each missing file is
listed in the README with the reason.

## What is redacted

Three kinds of file are cleaned, in `apps/vscode/src/sdk/diagnostics/redact.ts`:

- **Settings, MCP settings and the CI Board file** are copied key by key:
  - `StateManager`'s secret keys (`SecretKeys` in `state-keys.ts`) and
    `taskHistory` are never written;
  - a key that names a secret loses its value, which reads `[REDACTED]`:
    `apiKey`, `api_key`, `x-api-key`, `auth`, `pat`, and anything ending in
    `Key`, `Token`, `Secret`, `Password`, `Authorization`, `Credential`,
    `Cookie`, `Nonce` or `MachineId` (plural or not). Numbers and booleans
    under such a key are kept, so `planModeThinkingBudgetTokens` survives;
  - under `env`, `environment` and `headers` every value is replaced, whatever
    its name, since an MCP server's environment and request headers are where
    credentials live;
  - every remaining string goes through the text pass below.
- **Text files** (`last-model-request.txt`, `conversation.md`) go through one
  pass that replaces secret-looking values wherever they appear: `Bearer …` and
  `Basic …` credentials (the scheme stays), `sk-…` keys, GitHub `ghp_…` /
  `gho_…` / `github_pat_…` tokens, AWS `AKIA…` key ids, JWTs, and the value of
  `apiKey=…`, `token: …`, `password = …` and similar assignments.
- **Copied files** (`router/`, `trace/`, `logs/`) are copied as they are. The
  router logs hold model ids, timings and error messages; traces are redacted
  when they are written; the log file holds whatever the extension logged.

The redaction is eager, so a harmless setting can read `[REDACTED]`; that is
preferred to a leaked token. It is not a guarantee. The conversation, the last
model request, the trace and the logs hold whatever the model and its tools
saw: file contents, command output, paths, repository and branch names. Read
the bundle before you share it, and delete what you would not share.

## Sharing a bundle

1. Run **PlinyCode: Export Diagnostics Bundle** (Command Palette), or the
   button in **Settings → About**, or **Export diagnostics** under the error.
   The folder opens in the file manager.
2. Read `README.md` for what is in it, then look through the files.
3. Zip the folder and attach it to the issue, or paste the parts that matter
   (`versions.json`, the error's lines from the trace and the log, the
   `router/` tail for a routing problem).

## Testing

`apps/vscode/src/sdk/diagnostics/diagnostics-bundle.test.ts` (vitest, matched
by `src/sdk/**`) writes bundles into temporary data folders with fake
dependencies: the README's missing list, the folder name, the settings
redaction, the 500-line router tail, the trace cap, the log rotation, MCP and
CI Board redaction and the unparseable-settings case. The command, the reveal,
the notification and the About button need a dev host.
