# Pliny free model probe

Measured against the live gateway on 2026-09-22, 1 run(s) per model.
Regenerate with:

```sh
PLINY_API_KEY=... bun apps/vscode/scripts/probe-pliny-free-models.ts --runs 3
```

"Tool rate" is the fraction of runs in which the model actually emitted a tool
call when given one — the single most important property for agentic use, and
the reason a model with a great token rate may still be a poor default.

| Model | Context | Health | Tool rate | TTFT (median) | tok/s (median) |
| --- | --- | --- | --- | --- | --- |
| `snps-provider/qwen3-6-35b-a3b-1-28dd3` | 128k | healthy | 0 | 284 ms | 167.1 |
| `snps-provider/qwen3-coder-480b-a35b-inst-fp8` | 128k | healthy | 1 | 356 ms | 18 |
| `snps-provider/nemotron-3-ultra-550b-a55` | 200k | healthy | 1 | 358 ms | 64.6 |
| `snps-provider/qwen3-next-80b-a3b-instruct-d79b4` | 32k | healthy | 1 | 382 ms | 38.8 |
| `snps-provider/gemma-4-31b-it-29cea` | 128k | healthy | 1 | 408 ms | 20.9 |
| `snps-provider/llama-3-3-70b-instruct-128k` | 128k | healthy | 1 | 408 ms | 26.5 |
| `snps-provider/llama-3-3-70b-instruct-74k-ae1a8` | 74k | healthy | 1 | 454 ms | 19.5 |
| `snps-provider/nim-llama-3-3-70b-instruct-a7786` | 131k | healthy | 1 | 457 ms | 27.9 |
| `snps-provider/llama-3-1-70b-instruct-20ad2` | 32k | healthy | 1 | 460 ms | 15.3 |
| `snps-provider/nvidia-nemotron-3-super-120b-a12` | 256k | healthy | 1 | 553 ms | 42 |
| `snps-provider/qwen2-5-32b-instruct-fe66b` | 64k | healthy | 1 | 599 ms | 37.7 |
| `snps-provider/qwen3.5-397b-fp8` | 220k | healthy | 1 | 635 ms | 22.9 |
| `snps-provider/gemma-4-31b-it-1-reasoning` | 256k | healthy | 1 | 783 ms | 24.1 |
| `snps-provider/kimi-k2.6` | 256k | healthy | 1 | 791 ms | 86.6 |
| `snps-provider-internal-tests/glm-5-2` | 512k | healthy | 1 | 855 ms | 26 |
| `snps-provider/qwen3-8-27b` | 256k | healthy | 1 | 975 ms | 16.4 |
| `snps-provider-vmodels/glm-5.2` | 512k | healthy | 1 | 1058 ms | 28.4 |
| `snps-provider/GLM-5.2` | 512k | healthy | 1 | 1279 ms | 7.6 |
| `snps-provider/qwen3-6-27b` | 256k | healthy | 1 | 1750 ms | 19.2 |
| `snps-provider/qwen3-6-27b-ft` | 128k | healthy | 1 | 1990 ms | 12.1 |
| `snps-provider-sia/qwen3-8-27b-sia` | 256k | **down** | 0 | — | — |
| `snps-provider-sia/qwen3-5-397b-a17b-sia` | 220k | **down** | 0 | — | — |

## How this feeds the router

The default pool order in the generated rules file favours, in order: models
that answer reliably, models that really call tools, then latency. A model that
shows as **down** here is still left in the catalog (it may recover), but the
router benches it automatically after repeated failures at runtime.

## Trying it

FreeAuto is the default model, so a fresh install needs no setup. To run the
extension from source in Cursor or VS Code:

```powershell
pwsh apps/vscode/scripts/run-extension-host.ps1 -Editor cursor
```

Open the rules file from the command palette with **PlinyCode: Open FreeAuto
Routing Rules**. It is created on first activation, and saving it takes effect
on the next call without a restart.

Each call adds a timestamped row to the chat naming the model and the route that
chose it, and the end of every turn adds a summary. The same lines go to the
PlinyCode output channel.

To watch a failover happen, put a model that is currently down at the front of a
route's `use` list (the matrix above marks them) and send a message: the row
shows the failure and the model that took over, and the turn still completes.

## Regenerating the probe outside the editor

The gateway serves only its leaf certificate, without the SNPSica2 intermediate,
so Node cannot verify it against its own roots. The extension handles this
itself: when a request fails certificate verification it retries with the OS
store and the bundled Synopsys CAs (`apps/vscode/src/shared/tls-trust.ts`). A
standalone `bun` run does not, and needs the chain passed explicitly:

```powershell
$env:NODE_EXTRA_CA_CERTS = "<path to a PEM with the server, SNPSica2 and SNPSOfflineCA certs>"
bun apps/vscode/scripts/probe-pliny-free-models.ts --runs 3
```

Without it every model reports `unable to verify the first certificate`, which
looks like a total outage but is purely local trust configuration.

## Keeping runs going: the completion guard, the judge and `wait`

The agent loop ends a run as soon as a reply carries no tool call. The free
models use that exit far too early — real transcripts show them announcing a
step and stopping ("Let me check the log:"), promising to "check back at 15:28",
asking permission for something the user already asked for, reporting a failed
command as if it were the result, or degenerating into a repeated character for
thousands of characters. Three pieces push back, all only for free models (on
BalanceAuto, only when the turn's last call ran on a free model — see
[pliny-balance-auto.md](pliny-balance-auto.md)):

- **Pattern rules** (`unfinished-turn-guard.ts`, applied by
  `completion-guard.ts`) read the reply and, for the shell rule, the tool result
  it follows. A hit sends the model a `[SYSTEM]` reminder naming the problem
  and the chat shows `↻ … (rule: wait-bail-out, 1/3)`. A model that answers a
  reminder with the same stall gets one firmer reminder and the rest of the turn
  moves to the default route's lead model (`↪ switching to …`); a third stall in
  a row is accepted. At most three reminders per run.
- **The judge** (`router-completion-judge.ts`) runs once per run, only in act
  mode and only when the run made at least one tool call, when no rule fired: a
  small model is shown the request, what the run did and the final reply, and
  answers whether the request was carried out. "Not done" sends one reminder
  (`⚖ The task looks unfinished — …`); no verdict within `guard.judgeTimeoutMs`
  accepts the reply. Switch it off with `guard.judge: false` in the rules file.
- **`wait`** is a tool (`vscode-wait-tool.ts`) that pauses up to 10 minutes per
  call, an hour per turn, so a model waiting on a build or a benchmark can wait,
  read the log, and wait again instead of ending its turn. The free models are
  told about it in a system-prompt addendum (`router-prompt.ts`), and a failed
  or detached command's result carries a note telling them not to stop on it.

A reply that collapses into repetition is cut off mid-stream by the routed model
and treated like any other post-output failure: the run continues on another
model with a prompt to redo the step.

Every run appends one line to `pliny-free-auto-runs.jsonl` next to the rules
files: how it ended, the last model and tool, which rules fired, what the judge
said, and the reply's tail. `bun apps/vscode/scripts/summarize-free-auto-log.ts
--tails` turns that and the call log into per-profile, per-model and per-route
tables, including how often the classifier actually produced a verdict.

## Models that think in their content

The gateway exposes no reasoning channel for some self-hosted models: their
deliberation arrives as ordinary content. The thinking probe used to count only
reasoning deltas, so `kimi-k2.6`, `qwen3-6-35b-a3b-1-28dd3`,
`nemotron-3-ultra-550b-a55` and the sia `qwen3-5-397b-a17b` were catalogued as
non-reasoners and the off-switch was never sent to them. That is why the smart
profile's classifier and the judge (both on the 35B) answered with a
paragraph of thinking that was cut off before the JSON verdict: "classifier
gave no verdict (unusable reply: The user wants to run tests. …)".

The probe now treats a paragraph in answer to its one-word question as
reasoning (`IN_CONTENT_REASONING_MIN_CHARS`), and the catalog marks the four
as `defaultOn: true`. The three with a working `chat_template_kwargs`
off-switch get it on `quick` and utility calls; kimi has no measured
off-switch, reasons in content at every size, and past ~80k tokens tends to
end on its plan ("I need to: 1. Check … 2. Report …") instead of acting, so it
no longer leads the `default` route. The guard flags that ending too (a
first-person plan followed by imperative list items, and nothing after it).

Existing rules files keep their own route order: they are only written when
missing, so move `~/.cline/data/pliny-free-auto*.md` aside to pick up the new
defaults.

## Reading the call log

Each line of `pliny-free-auto-calls.jsonl` now records what the call produced
besides how long it took: `finishReason`, `textChars`, `reasoningChars` and
`toolCalls`. A `stop` with text and no tool call is a reply that ended the
run; the summary script's "Text-only stops" column counts those per model, so
the stop rate of each free model can be read off real use instead of
transcripts.

## The agent terminal

Commands the model runs go through a terminal with `GIT_PAGER=cat`,
`PAGER=cat` and `GIT_TERMINAL_PROMPT=0` (`agent-terminal-env.ts`). Without
them `git branch` or `git log` with more output than the terminal is tall
hands over to a pager that waits for a keypress the model cannot send, which
looked like a three-minute hang in one benchmark session.
