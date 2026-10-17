# Session traces and the log file

After a bad run, the chat transcript used to be all that was left: the Output
channel is gone with the window, **Show Last Model Request** keeps only the
last request of a few conversations in memory, and the router's JSONL logs
cover only `auto-free` and `auto-paid-balanced` calls. Two files now persist
what happened:

- a **trace** per conversation, one JSON line per step: each model request and
  reply, each tool call and result, each routing decision, and each run that
  ended badly;
- a rotating **log file** with every line the extension logs.

Both live in PlinyCode's data folder, `~/.cline/data` unless `CLINE_DATA_DIR`
or `CLINE_DIR` says otherwise (the same folder as the router's
`pliny-free-auto-calls.jsonl`).

## The trace

`traces/<session id>.jsonl`, where the session id is the conversation's id (the
folder name under `sessions/`). It is written by
`apps/vscode/src/sdk/trace/session-trace.ts`, which `SdkSessionConfigBuilder`
installs on every session after the router and the advisor: it wraps the
session's model factory, so it sees the request the router passes on, and the
session's `beforeModel`, `beforeTool`, `afterTool` and `afterRun` hooks.
The router reports its own decisions to it (`RouterInstallDeps.onCallEvent`);
its `pliny-free-auto-calls.jsonl` and `pliny-free-auto-runs.jsonl` are
unchanged.

Sub-agents are traced into the same file as the conversation that spawned
them, with their own `agentId` and a `parentAgentId`.

### Records

Every line is a JSON object with `ts` (ISO time), `sessionId`, `type`, and when
known `agentId`, `parentAgentId`, `runId` and `iteration` (taken from the latest
hook snapshot of that agent; the first request of a run may come before any).

| `type`        | Fields                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`     | `modelId` (the session's model; for a router, the router's id), `systemPromptSha256`, `systemPromptChars`, `messageCount` and `totalChars` (the whole message list, as serialized before redaction), `tools` (names), `fromIndex`, `newMessages`, `reset` and `messages` (redacted, see below): only the messages added since the agent's previous `request` record, see "Incremental requests". The system prompt itself is never written. |
| `stream`      | `modelId`, `routedModelId` (the model that served the call, from the usage event the router tags), `ttftMs`, `durationMs`, `finishReason`, `error`, `usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `cost`, `estimated`), `textChars`, `reasoningChars`, `toolCalls`. |
| `tool_call`   | `tool`, `toolCallId`, `input` (redacted, strings cut at 2 000 characters), `skipped` / `stopped` when a hook skipped the call or stopped the run on it.                                                                                                                      |
| `tool_result` | `tool`, `toolCallId`, `durationMs`, `ok`, `output` (redacted, cut at 2 000 characters).                                                                                                                                                                                      |
| `router`      | `kind` (`start`, `failover`, `success`, `error`), `profile`, `subAgent`, `modelId`; on `start` the `route`, `candidates`, `effort`, `classification`, `estimatedTokens` and `callIndex`; on `failover` the `error`, `nextModelId` and `benched`; on `success` and `error` the `durationMs`, `ttftMs`, `finishReason`, `textChars`, `reasoningChars` and `toolCalls`. |
| `run_end`     | A run that completed: `status`, `iterations`, `usage`.                                                                                                                                                                                                                       |
| `error`       | A run that failed or was aborted: `status`, `iterations`, `error`.                                                                                                                                                                                                           |
| `truncated`   | The last line of a file that reached its cap: `bytes`, `maxBytes`.                                                                                                                                                                                                           |

### Redaction and limits

The messages of a `request` and the `input` and `output` of tool records are
copied, not referenced, and the copy is cleaned before it is written:

- the value of any key that names a secret (`apiKey`, `token`, `authorization`,
  `password`, `secret`, `cookie`, `credentials`, anything ending in `Key`,
  `Token`, `Secret` or `Password`, ...) becomes `[REDACTED]`;
- secret-looking values inside text are replaced: `Bearer ...` and `Basic ...`
  headers, `sk-...` keys, GitHub `ghp_...` / `github_pat_...` tokens, AWS
  `AKIA...` key ids, JWTs, and `apiKey=...` / `token: ...` assignments;
- text parts of messages are cut at 4 000 characters and tool arguments and
  results at 2 000, with ` [+N chars]` appended; image data is replaced by its
  size.

A conversation's file stops at **20 MB**: one `truncated` line is written and
nothing more. At extension start the `traces/` folder is pruned, oldest files
first, until it is under **200 MB**.

Writing is asynchronous and queued per file, so a trace never waits on the
disk; a write that fails is logged once (`[trace] Could not write ...`) and
dropped. Nothing in the trace can throw into the agent loop.

### Setting

`plinycode.trace.enabled` (default on). It is read for every record, so
switching it off stops the writing at once, without restarting the
conversation; existing files are kept.

### Incremental requests

The agent sends the whole conversation on every iteration, so writing every
request in full would grow a long conversation's trace quadratically and reach
the 20 MB cap within a few dozen iterations. A `request` record therefore holds
only what is new. Per agent, the trace remembers how many messages it has
written and the id of the last one; the next record's `messages` array starts
after that position, `fromIndex` says where in the request it starts and
`newMessages` how many it holds, while `messageCount` and `totalChars` still
describe the whole list. The first request of a session (and of each sub-agent,
which has a position of its own) writes everything from index 0. When the list
is shorter than remembered, or the message at the remembered position has
another id (compaction, restart-from-here, truncation), the whole list is
written again with `reset: true`.

### Reading a trace

To rebuild what the model saw at an iteration, take the latest `request` with
`reset: true` (or the first one) and append the `messages` of every later
`request` of the same `agentId`. The other lines are self-contained: the
`stream` after a `request` tells how the model answered (which model, how long,
which finish reason), the `tool_call` / `tool_result` pairs what happened next,
and a `router` line with `kind: "failover"` why a call changed model. A quick
look from the shell:

```sh
jq -c 'select(.type == "stream") | {ts, iteration, routedModelId, finishReason, durationMs, usage}' ~/.cline/data/traces/<id>.jsonl
```

## The log file

`logs/plinycode.log`, written by
`apps/vscode/src/shared/services/file-log-sink.ts`. Every line the extension
sends through `Logger` goes there as well as to the **PlinyCode** Output
channel (`extension.ts` passes the sink to `HostProvider` as its
`logToChannel`). The file rotates at **5 MB**; five files are kept in all:
`plinycode.log`, `plinycode.1.log` (the newest rotated) through
`plinycode.4.log`.

Lines are queued and appended in the background; the queue is flushed when the
extension deactivates. If the folder cannot be written, the sink says so once
in the Output channel and drops its lines for the rest of the window, so a
read-only data folder never breaks logging elsewhere.

**PlinyCode: Open Log File** in the Command Palette opens the current file in
an editor tab, like **Open Router Call Log** does for the router's log.
