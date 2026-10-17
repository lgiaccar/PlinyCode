# Eval cases

Each case is a task for the agent, a project to do it in, and checks on the result. Why the harness exists, how to run it and what comes next are in [docs/eval-harness.md](../../../docs/eval-harness.md). This file is the format reference.

```text
sdk/scripts/eval/
  run.ts               the runner
  seed-cassettes.ts    writes the scripted cassettes of the seed cases
  lib/                 case loader, assertions, headless session, cassette builders
  fixtures/<name>/     starting projects, copied to a fresh temp dir per run
  cases/<id>/
    case.yaml          the case
    cassette.json      the model's recorded responses, for offline playback
```

## case.yaml

```yaml
id: fix-failing-test            # must equal the directory name
tags: [act, editor, bugfix]     # optional; filter with --tag
fixture: buggy-math             # a directory under fixtures/
mode: act                       # act (default), plan or ask
model: snps-provider/GLM-5.2    # a Pliny model id from the catalog
maxIterations: 8                # the agent loop's iteration cap
timeoutSeconds: 120             # optional; default 120 offline, 900 when recording
prompt: >-
  `bun test` fails in this project. Find the bug in math.ts and fix it.
assertions:
  - type: command_exit_code
    command: bun test
    code: 0
```

Unknown fields are rejected, so a typo fails the run instead of being ignored. `model` is a concrete model: the FreeAuto and BalanceAuto routers live in the extension, not the engine, so router profiles are not runnable here yet.

### Assertions

Every assertion runs after the agent stops, against the temp copy of the fixture. Paths are relative to it and may not leave it.

| Type | Fields | Passes when |
| --- | --- | --- |
| `file_exists` | `path` | the file exists |
| `file_contains` | `path`, and `text` or `regex` | the file contains the text, or the regex (multiline) matches |
| `command_exit_code` | `command`, `code` | the shell command, run in the workspace, exits with `code` (two-minute limit) |
| `no_tool_errors` | | no tool call threw or reported `success: false` (plan-mode write rejections count) |
| `iterations_lte` | `n` | the agent used at most `n` loop iterations |
| `final_text_contains` | `text` | the agent's last message contains `text` |

A case passes when every assertion passes and the agent finished normally (`finishReason: completed`). Hitting `maxIterations`, an error or the timeout fails the case whatever the assertions say.

## cassette.json

The cassette is what the VCR in `@plinycode/shared` (`startVcr`, [vcr.ts](../../packages/shared/src/vcr.ts)) plays back: a JSON array with one entry per HTTP request, served in order. An entry matches a request on method and path only, so the host and the request body may differ between recording and playback. Tool results and temp-dir paths change on every run, which is why request bodies are not checked.

For the Pliny provider every entry is a chat completion:

```json
{
	"scope": "https://snps-inference.internal.synopsys.com",
	"method": "POST",
	"path": "/api/llm/chat/completions",
	"status": 200,
	"response": "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"GLM-5.2\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Done.\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
	"responseIsBinary": false,
	"contentType": "text/event-stream"
}
```

`response` is the raw server-sent-event stream of an OpenAI-compatible chat completion with `stream: true`: `data:` lines carrying `choices[0].delta` (`content`, `reasoning_content`, `tool_calls`), a chunk with `finish_reason` (`tool_calls` or `stop`), a final chunk with `usage`, then `data: [DONE]`. Playback streams it chunk by chunk with no delay.

When the agent asks for more responses than the cassette holds, playback throws `[VCR] No matching recording ...`, the run ends with `finishReason: error`, and the case fails with that message. When it stops early, the summary notes how many responses went unused.

### Where cassettes come from

- **Recorded**: `run.ts --record` runs the case against the live gateway and overwrites `cassette.json` with what the gateway streamed. This is the normal way.
- **Scripted**: the seed cases were written without gateway access. Their turns are in `seed-cassettes.ts`, rendered by `lib/cassette.ts`; regenerate them with `bun sdk/scripts/eval/seed-cassettes.ts`. Tool-call arguments use paths relative to the workspace, because the engine resolves them against the session's cwd.

Cassettes are committed tab-indented so they pass the Biome format check; `--record` rewrites them that way.
