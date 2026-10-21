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

Each router compacts against an input budget of its own, at the
`plinycode.compaction.threshold` share of it (90% by default), and advertises
the largest window its model order holds (`plinyRouterBudget` in
`sdk/packages/llms/src/providers/pliny-models.ts`):

| Router | Budget | Compacts at (90%) | Window |
| --- | ---: | ---: | ---: |
| `auto-free` | 200k | about 180k | 512k |
| `auto-free-smart` | 300k | about 270k | 512k |
| `auto-free-fast` | 64k | about 58k | 256k |

kimi-k2.6 leads `auto-free`. With its 64k output reserve and the 1.15 margin
it takes requests up to about 167k of its own tokens; past that the size
filter hands the request to the GLM-5.2 replicas (512k) that follow it in the
order, which take about 388k. `auto-free-smart` leads with GLM-5.2, so a long
run stays on it. The size filter measures each candidate in its own tokens,
from the ratio the provider counts taught the token calibration
([context-compaction.md](context-compaction.md)): until 0.2.5 it counted three
characters per token for every model, and kimi, which packs about 3.9, dropped
out at about 127k, before compaction ran.

The budget was 92k, sized to the 128k tier so the whole pool stayed routable,
then 150k. At 92k a 26k-character system prompt and 39k characters of tool
definitions took a quarter of it, and long runs compacted every ten or so
iterations and re-read the same files after each compaction. Fewer, later
compactions keep more of the working set, at the cost of slower prefill on the
largest requests. `auto-free-fast` compacts sooner: a shorter history keeps
every call quick and on the small Qwen models, which degrade first as the
context grows.

**Settings → Router → Compaction** sets a router's budget and the size a
compaction shrinks to, in tokens or percent ([router-settings.md](router-settings.md#compaction)).
The context setting of the model tuning button ([model-tuning.md](model-tuning.md))
can lower a router's budget further, never raise it.
The timestamped rows (below) are shown in the chat only; they never reach the
model. Whether the conversation compacts at all follows the auto-condense
setting like any other model: the router only attaches the free summarizer the
compaction uses, so turning auto-condense off leaves a routed conversation
with the engine's overflow recovery alone.

## The profiles and their routes

The three FreeAuto profiles share one router but lead their routes with
different models, so that comparing them on real work says something. Each
profile has one model order, which the main routes (`default`, `coding`,
`plan-and-reasoning`, `ask-reasoning`) use and which heads its pool. The
built-in defaults (`router-rules.ts`) are the orders the routers were tuned to
in Settings → Router during the 0.2.4 field runs:

| Profile | Model order | Pool |
| --- | --- | --- |
| `auto-free` | kimi-k2.6, GLM-5.2 (internal-tests), GLM-5.2 (vmodels), nemotron ultra, nemotron super; plan mode starts on the vmodels replica | only these routes' models: no fallback to the rest of the catalog |
| `auto-free-smart` | GLM-5.2, GLM-5.2 (internal-tests), kimi-k2.6, nemotron ultra, nemotron super | the order, then every free model |
| `auto-free-fast` | qwen3.5-397b, nemotron ultra, kimi-k2.6, qwen3-coder | the order, then every free model |

The other routes keep their own lists:

| Route | `auto-free` | `auto-free-smart` | `auto-free-fast` |
| --- | --- | --- | --- |
| `huge-context` (≥ 180k tokens) | GLM-5.2 (vmodels, internal-tests, primary) | the same | the same |
| `subagent` | kimi-k2.6, nemotron super | kimi-k2.6, qwen3-coder, nemotron super | qwen3-coder, qwen3.5-397b, nemotron super |
| `quick` | nemotron super, kimi-k2.6 | qwen3-next-80b, nemotron super, kimi-k2.6 | qwen3-next-80b, qwen3-coder, nemotron super |

Planning thinks (`high`), a reasoning question in ask mode thinks (`medium`),
coding and quick work do not. `auto-free-smart` adds the classifier.
`auto-free-fast` has no `ask-reasoning` route and turns reasoning off
everywhere.

**Plan and ask mode route differently.** Every plan-mode turn takes the
`plan-and-reasoning` route, whatever its wording: a plan is only as good as
the thinking behind it, and before this only prompts with a word like "plan",
"design" or "why" got there. Ask mode, and a side question in any mode, routes
as `ask` (it used to route as plan): a question about what something is or
where it lives stays on the quick route, and only one that asks for reasoning
takes `ask-reasoning`. A rules file can match the three modes with
`mode: plan`, `mode: act` or `mode: ask`. These are built-in defaults: a
rules file you edited keeps its own routes until you delete it (or its YAML
block) and let it be seeded again.

Kimi leads the default profile again. It was demoted after a run of
turns in which it announced a tool call and never made it; the transcripts
show why: it emits tool names with its chat template's namespace attached
(`functions-read_files`), the gateway passes that through, and the AI SDK
rejected every such call as an unavailable tool. A weak model does not recover
from that error, it apologises and describes the corrected call instead. The
gateway now repairs the name (`resolveMisnamedTool` in
`sdk/packages/llms`), also covering hyphenated (`run-commands`) and
namespaced (`tools.`, `default_api.`) variants, so the call runs. When kimi
still stops early, the completion guard's escalation hands the turn to the
next model of the default route, a GLM-5.2 replica.

### Kimi and tool-call ids

The namespaced names were a symptom. The cause was the tool-call ids in the
history PlinyCode sent. Kimi writes a call as
`<|tool_call_begin|>functions.read_files:3<|tool_call_argument_begin|>{…}`:
the call's id holds the tool's name and a running index, and the model's chat
template shows it its earlier calls by that id. Since 0.1.5-test.7 every id on
the wire was rewritten to `[a-zA-Z0-9-]` plus a hash, because Claude on Bedrock
rejects anything else. Kimi then read its own earlier calls as
`functions-read-files-3-9tb01v`, imitated that, and its server could no longer
parse the result. Depending on how far the imitation went, the call came back
with the whole section glued into the tool name and empty arguments ("no tool
is named …"), sat in the reply text as raw tokens, or never arrived, which is
the "announced a step and stopped" that the completion guard kept catching.

`apps/vscode/scripts/probe-kimi-tool-call-ids.ts` replays one history (six earlier calls, the next
step is another call) with three id styles, 24 runs each, against
`snps-provider/kimi-k2.6`:

| Ids in the history                              | Usable tool call |
| ----------------------------------------------- | ---------------- |
| rewritten for Bedrock, as sent until 0.1.7-test.9 | 6 / 24         |
| another model's ids (`call-…`, `toolu-…`)       | 17 / 24          |
| Kimi's own, `functions.<tool>:<index>`          | 23 / 24          |

So three things now happen for Kimi models (`isKimiModel`; code in
`sdk/packages/llms/src/providers/kimi-tool-calls.ts`):

- **Its history carries its own ids.** `withKimiToolCallIds` renumbers every
  call in the outgoing request as `functions.<tool>:<index>`, whichever model
  made it, and `withSafeToolCallIds` leaves a Kimi request's ids alone. Stored
  messages keep the ids they had.
- **A call glued into the tool name is taken apart.** The repair hook reads
  the tool and the JSON arguments back out of a name like
  ` functions-read_files-2-4wzk2r {"files": […]} <|tool_call_end|>`, and the
  name resolver also accepts a call id (`functions.read_files:3`) or camelCase
  (`readFiles`) for a tool.
- **A call left in the reply text is run.** The text from
  `<|tool_calls_section_begin|>` on is held back; when the reply ends, the
  calls that name a real tool and carry JSON arguments are executed and the
  section is not shown. Text no call can be read from is shown as it arrived.
  This now happens for every model, together with the formats below.

### Tool calls written as text, on any model

Models also fall back to a tool-call syntax from their training data and write
it into the reply as text, so nothing runs and the turn ends on what looks
like an answer. Seen in real sessions: Kimi K2.6 writing Anthropic's
`<invoke name="read_files"><parameter name="files">…</parameter></invoke>` on
the first reply of a FreeAuto turn, and a BalanceAuto model writing Qwen3-Coder's
`<tool_call><function=read_files><parameter=files>…` block.
`createTextToolCallFilter` (`sdk/packages/llms/src/providers/text-tool-calls.ts`)
holds such a section back while the reply streams, for every model that has
tools, and once the reply is complete turns it into the tool calls it meant.
It reads Anthropic's XML (with or without its namespace prefix and
`<function_calls>` wrapper), Qwen3-Coder's XML, Hermes `<tool_call>{json}`
blocks and Kimi's tokens. A parameter is kept as text when the tool's schema
says it is a string and read as JSON otherwise; Windows paths written with
single backslashes are repaired. It leaves the text alone, and runs nothing,
when the section is inside a code fence, when prose follows it, when one call
names a tool that does not exist or has arguments it cannot read, when the
reply also made real tool calls, or when the reply failed or was cut short.

What the filter cannot read reaches the completion guard, whose
`text-tool-call` rule sends `[SYSTEM] Your last message wrote a tool call as
text …` and shows `↻ The model wrote a tool call as text, so nothing ran`.
Unlike the other rules it applies to every model, paid ones on BalanceAuto
included, and on the first reply of a run. The router's system-prompt addendum
also tells the free models to make calls only through the tool-calling
interface and to reply in the user's language.

When a name still resolves to nothing, the error quoted back to the model is
cut to 80 characters and stripped of control tokens, so it does not hand the
model another copy of the bad call to imitate.

The rules files are seeded from these defaults on first activation and carry a
marker with a hash of their yaml block. A file nobody edited is refreshed when
the defaults change (the old copy is kept as `.bak`); an edited file, or one
written before the marker existed, is left alone. To adopt new defaults into
an old, edited file, delete it and reopen the editor.

## Trying it

FreeAuto is the default model, so a fresh install needs no setup. To run the
extension from source in Cursor or VS Code:

```powershell
pwsh apps/vscode/scripts/run-extension-host.ps1 -Editor cursor
```

Open the rules file from the command palette with **PlinyCode: Open FreeAuto
Routing Rules**. It is created on first activation, and saving it takes effect
on the next call without a restart. **Settings → Router** changes the model
order and the other knobs without editing the file, and its values override
the file's ([router-settings.md](router-settings.md)).

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
  and the chat shows `↻ … (rule: wait-bail-out, 1/8)`. A model that answers a
  reminder with the same stall gets one firmer reminder and the rest of the turn
  moves to another model (`↪ switching to …`): the first time in a turn, the
  next free model of the route, then of the `coding` route, then of the pool;
  the second time, the default route's lead model; a third stall in
  a row is accepted. The same switch happens on the third stall in a run even
  when the model acted in between: some models (Kimi K2.6 is one) act on every
  reminder and then stall again on the next step. A run gets at most eight
  reminders, and at most three the model did not act on (the rules file's
  `escalation` block sets the eight, the three stalls and the six failed
  commands that also switch a turn); a reminder followed by
  a tool call does not count against the three. When the guard lets a stalled
  reply end the run, the chat says why (`⏹ … not asking again: …`) instead of
  ending on a plain "Completed", and the run log records it as `guardGaveUp`.
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
model with a prompt to redo the step. `looksDegenerate` catches a short unit
repeated (`. . .`, `]]]]`) and a chunk of up to 1 500 characters repeated at
least four times back to back. The second case is a model that writes the same
sentence about the fix hundreds of times instead of making the tool call, until
it reaches the output-token cap. The reply text and the reasoning are checked
separately.

### When a run fails

A run that fails after the model produced output is recovered by
`onRunError` in `router-integration.ts`, at most three times a turn:

- **A dropped connection** (`terminated: SocketError: other side closed`,
  `ECONNRESET` and the like, `isTransportError`) says nothing about the model.
  The first one in a turn waits two seconds and retries without counting a
  failure against the model's health, so a gateway blip cannot bench it; the
  chat shows `⚠ The connection to **Claude Sonnet 5** dropped … · retrying`.
  A second one in the same turn is treated like any other failure.
- **Any other failure** counts against the model and moves the turn on:
  `⚠ Turn failed on **…** · retrying with another model`.
- **The retry continues the turn.** The run that recovers a failed one keeps
  the turn's call log, failover count, classifier verdict and the edits the
  reviewer needs, so the limit of three failovers applies across the retries
  and the end-of-turn summary lists every call.
- **A hidden prompt resumes the reply.** When the stream died while the model
  was still writing a tool call's arguments, that call never reached the
  history; the llms stream adds `— cut off while writing a <tool> call` to the
  error, and the prompt tells the model the call was lost and must be made
  again through the tool-calling interface rather than "continued" as text.

Chat rows name models by their catalog name (`Claude Sonnet 5`, `Kimi K2.6`),
falling back to the id without its pool prefix.

The guard and the judge check that the work was done, not that it is right.
Once they accept a reply, the reviewer pass has a second free model read the
diff of what the run changed and hands likely defects back to the working
model once; its outcome is the `review` field of the run log line. See
[review-pass.md](review-pass.md).

Every run appends one line to `pliny-free-auto-runs.jsonl` next to the rules
files: how it ended, the last model and tool, which rules fired, what the judge
said, and the reply's tail. `bun apps/vscode/scripts/summarize-free-auto-log.ts
--tails` turns that and the call log into per-profile, per-model and per-route
tables, including how often the classifier actually produced a verdict.

## Images

No free Pliny model accepts image input; five hosted ones do (Claude Sonnet
5, 4.6 and 4.5, Claude Haiku 4.5 and GPT-5.2: `attachment: true` in the
catalog, the `images` capability). A FreeAuto conversation with an image in it
used to fail every call with "auto-free has no model that accepts
images among its candidates", and kept failing, because the image stays in the
history. Now the router handles images itself (`router-images.ts`), and the
FreeAuto profiles declare image input, so the prompt box no longer warns that
an attached image will be ignored.

A routed call carries images when the user pasted or attached one, or when a
tool returned one: `view_image` ([agent-tools.md](agent-tools.md)), or
`read_files` on a PNG. The call is routed as if it had none. A candidate that
accepts images (on BalanceAuto, the paid Claude models) gets the request as it
is; any other gets a copy in which each image is replaced by text, according
to `plinycode.router.images`:

| Setting | A text-only model gets | Spends |
| --- | --- | --- |
| `describe` (default) | `<image_description sha="…">…</image_description>`: the image described by the cheapest image-capable model | one call per new image |
| `vision-model` | a turn that brings a new image runs on the cheapest image-capable model, image included; later turns are routed as usual and get descriptions | that model's price for every call of the turn |
| `off` | `[An image was attached here but is not shown to you: …]` | nothing |

- **The describer** is the cheapest image-capable model in the catalog the
  conversation may use, ranked by what a description costs (about 1,600
  tokens in, 400 out): Claude Haiku 4.5 today, at roughly $0.004 an image. A
  free model with image input would be chosen first if the catalog ever had
  one. Router ids are never chosen. It gets a fixed instruction (transcribe
  all visible text verbatim, describe the layout, what is selected or shows an
  error, the boxes and arrows of a diagram, the axes and values of a chart,
  code in a fenced block; no speculation, no advice), the user's latest
  message for context, and the image; the reply is capped at 1,200 tokens and
  the call at 60 seconds.
- **Once per image.** Descriptions are kept per conversation, in memory, by
  the first 12 hex digits of the image's SHA-256, so the same image re-sent
  with every later request is described once. Two calls that need the same
  image at once share one description. An image whose description failed is
  not retried within the turn. At most eight new images are described per
  call; the rest get the note. After a window reload the cache is empty and
  each image still in the history is described once more.
- **Paid models.** On BalanceAuto paid models are allowed. On FreeAuto they are
  allowed only while **Unlock Pliny paid models** is on (Settings → API
  configuration). That toggle lives in the webview's local storage, so the
  webview mirrors it to the extension (`plinyPaidModelsUnlocked`, sent when it
  loads and on every change). Without a paid model allowed and no free one
  that can see images, `describe` and `vision-model` fall back to `off`, and
  the chat says why and how to turn it on.
- **Budget and cost.** Before paid image work the conversation's spend is
  checked against its budget with the advisor's rule
  ([advisor-tool.md](advisor-tool.md)): it applies on a free model too, and a
  spent budget replaces the image by a note instead of pausing the run. Each
  description adds a hidden `subagent_usage` row with `source: "vision"`, so
  its cost is in the task header (the token panel lists it as **Image
  descriptions**, one row per image), the next budget check and the history
  record (`extraUsage.vision`). A task running in the background records it in
  its history record directly. In `vision-model` mode the turn's calls are
  ordinary model calls on a paid model and are counted like any other; the
  completion guard and the judge leave a turn alone while it runs on the paid
  model.
- **Rows.** The first description in a conversation adds `🖼 Images were
  described by **Claude Haiku 4.5** because the free models can't see images
  (…)`; a `vision-model` turn says which model it runs on, and its routing row
  shows `route: images`. A paid-locked fallback, an `off` drop, a spent
  budget and a failed description each get one row (the first two once per
  conversation, the others once per turn).

The stored conversation is never changed: switching to an image-capable model
later sends it the real images.

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

The off-switch alone still let a few classifier calls through (5 in two days
of heavy use): the reply was the same "The user wants to …" paragraph, cut off at the 512-token
cap. Replaying those prompts with the switch on always produced a verdict, so
the switch did not take effect on those calls. The classifier and the judge
now also ask for a JSON-only reply (`responseFormat: "json"` on the request,
sent to Pliny as `response_format: {"type": "json_object"}`). With it the 35B
answers with the object in about 300 ms even with thinking left on, and the
other free models and Haiku accept the field without error.

## Reading the call log

Each line of `pliny-free-auto-calls.jsonl` now records what the call produced
besides how long it took: `finishReason`, `textChars`, `reasoningChars` and
`toolCalls`. A `stop` with text and no tool call is a reply that ended the
run; the summary script's "Text-only stops" column counts those per model, so
the stop rate of each free model can be read off real use instead of
transcripts.

### Tokens and cost

Each call line also carries what the call used, summed over the usage events
the gateway streamed for it (`routed-agent-model.ts` hands them to the
observer with the call's outcome):

| Field | Meaning |
| --- | --- |
| `usage` | `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens` (when the provider reports them), `estimated: true` when the provider reported nothing and the counts are a character-based estimate. Absent when the call ended without a usage event, which is usual for a failover. |
| `costUsd` | The gateway's cost or the catalog price. Always `0` on a free self-hosted model; absent on a paid model whose call reported no usage. |
| `runId`, `iteration` | The engine's run and iteration the call belongs to (from the `beforeModel` hook), the same ids as the session trace's records, so a call line can be found in `traces/<session id>.jsonl`. |

A call that fails after its output still logs the usage it reported before the
failure. All of these are optional: lines written before them still parse.

Each run line gains the totals of its turn, so it doubles as the turn record:

| Field | Meaning |
| --- | --- |
| `runId` | The engine's run id. |
| `usage`, `costUsd` | Tokens and cost of every call the turn made so far, the same calls `calls` counts. A turn that was recovered after a failure has a line per run, and the later lines include the earlier runs' calls. |
| `models` | Calls per model, in the order each was first used. |
| `paidCalls`, `paidCostUsd` | The calls that ran on a paid (hosted) model, and their cost: BalanceAuto's paid share of the turn. |
| `failovers` | Failovers spent in the turn. |
| `subAgentCalls`, `subAgentUsage`, `subAgentCostUsd` | On the main agent's line, when sub-agents ran in the turn: their calls, tokens and cost. Sub-agent runs also have lines of their own. |

The judge's verdict (`judge`), the guard rules that fired (`guardRules`,
`nudges`, `escalated`, `guardGaveUp`) and the reviewer's findings (`review`)
were already on the run line. The run log was extended rather than a `turn`
record added to the call log because it already holds one line per run with
those verdicts, and the call log stays one line per model call.

### The summary script

```sh
bun apps/vscode/scripts/summarize-free-auto-log.ts [calls.jsonl] [--runs runs.jsonl] [--since 2026-10-01] [--tails]
```

Without a path it reads both logs from the data directory. `--since` takes a
date (midnight UTC) or a full ISO time. Besides the latency, outcome, run
ending and guard tables, it prints:

- **Tokens and cost by model** and **by route**: calls, how many reported
  usage, input, output, cache read and write, reasoning tokens, total cost and
  cost per priced call. A paid call with no cost is shown as `+N unpriced`
  rather than counted as free.
- **BalanceAuto: paid vs free calls**: calls, tokens and cost on paid and on
  free models, and how many successful main-agent turns stayed free.
- **Cost per successful turn**: per profile, the main agent's turns that ended
  on a reply or a completion tool, with total, mean and median cost (sub-agent
  spend included) and the median tokens and calls per turn.

A sample, from a synthetic log:

```text
## Tokens and cost by model (all calls)

|  | Calls | With usage | Input | Output | Cache read | Cache write | Reasoning | Cost | Cost/call |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `snps-provider/kimi-k2.6` | 3 | 2 | 31.3k | 730 | 0 | 0 | — | $0 | $0 |
| `aws-bedrock-vmodels/claude-4-6-sonnet-high-thinking` | 2 | 2 | 42.7k | 3.1k | 30.0k | 12.1k | 1.0k | $0.16 | $0.08 |

## BalanceAuto: paid vs free calls

|  | Calls | Input | Output | Cost | Share of cost |
| --- | --- | --- | --- | --- | --- |
| Paid | 3 (50%) | 50.8k | 3.6k | $0.17 | 100% |
| Free | 3 (50%) | 31.3k | 730 | $0 | 0% |

Successful main-agent turns: 2, 1 (50%) stayed on free models; 1 used a paid model, at $0.16 a turn on average.

## Cost per successful turn (main agent, sub-agents included)

| Profile | Turns | With cost | Total | Mean/turn | Median/turn | Tokens/turn (median, in+out) | Calls/turn (median) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| balance | 2 | 2 | $0.17 | $0.09 | $0.09 | 43.2k | 3 |
```

The report is built by `apps/vscode/src/sdk/router/router-log-summary.ts`,
next to the record types, and tested there with old and new lines.

## Measuring the classifier

`apps/vscode/scripts/router-classifier-labels.jsonl` is a hand-labelled set of
52 requests, written from the tier descriptions in the classifier's prompt
(`router-classifier.ts`) and the routes in `router-rules.ts`. Each line is
`{ prompt, expectedTier, expectedThink, note }`, plus `mode` (`plan` or `act`,
act by default) and `contextTokens` (the conversation size the classifier is
told, 3 000 by default). It has 15 `quick`, 15 `code`, 14 `reason` and 8
`huge` labels, 13 of them with thinking on. The `huge` labels all claim at
least 180k tokens, because the huge-context route admits nothing smaller; a few
`quick` and `code` labels claim a large but smaller context, so size alone
must not read as huge.

```sh
bun apps/vscode/scripts/eval-router-classifier.ts --dry-run          # print what would be sent, no gateway
PLINY_API_KEY=... bun --use-system-ca apps/vscode/scripts/eval-router-classifier.ts \
    [--profile smart|balance] [--model <id>] [--timeout <ms>] [--tier reason] [--limit 10]
```

The script builds each request with `buildClassifierRequest` and asks the
profile's classifier model through `runClassifier`, as a turn's first call
does, one label at a time. It prints tier, think and combined accuracy, the
tier confusion matrix (a `none` column counts labels with no verdict), the
think confusion matrix and every miss with its note, and writes each result to
`ai_output/eval/classifier-<timestamp>.jsonl`. The label file lives with the
extension's scripts rather than in `sdk/scripts/eval`: the classifier is
extension code, and the eval harness runs the engine without the router.

`router-classifier-eval.test.ts` checks the file's schema, that every tier has
at least five labels, that thinking is both on and off, that there are no
duplicates, and that only `huge` labels claim a context the huge route admits.
It never calls the gateway, and neither does CI.

The classifier is no longer offered the `huge` tier (its instructions name
`quick`, `code` and `reason`, with the chores spelled out as `code`); a `huge`
reply still parses, and `selectRoute` remaps it by size, so the `huge` labels
are still scored. The request it sees is the user's text alone: `<editor_state>`
and `<mode_notice>` are stripped, and runtime reminders, hook context and
compaction summaries are left out of its digest of earlier messages
(`isRuntimeInjectedMessage` in `unfinished-turn-guard.ts`), as they are for
the keyword routes.

The first run, on 2026-10-17 with the default classifier
(`qwen3-6-35b-a3b-1-28dd3`, 8 s timeout): tier 41/52 (79%), think 42/52
(81%), both 36/52 (69%). `quick` and `code` were all right; four `reason`
labels (all with thinking on) timed out with no verdict, and `huge` was
confused with `quick`, `code` and `reason` when the prompt did not say "whole
repository".

## The agent terminal

Commands the model runs go through a terminal with `GIT_PAGER=cat`,
`PAGER=cat` and `GIT_TERMINAL_PROMPT=0` (`agent-terminal-env.ts`). Without
them `git branch` or `git log` with more output than the terminal is tall
hands over to a pager that waits for a keypress the model cannot send, which
looked like a three-minute hang in one benchmark session. The same file tells
Git Credential Manager, pip, apt and npx not to prompt.

A command that still stops on a question ("Overwrite? [y/N]", "Password:")
used to block the turn for the five minutes of the auto-proceed timeout, then
came back as "still running", which the free models often answered by ending
their turn. Once a command has started, the terminal now looks at its last
output line after 8 s of silence (`INPUT_PROMPT_IDLE_TIMEOUT`,
`looksLikeInputPrompt`); a line that reads as a question gets Ctrl+C, and the
tool result says which question it was and to rerun the command
non-interactively. The completion guard's failed-command rule then keeps the
model on the task.

## What the model was given

Every turn starts with a chat row such as `Context: 2 rules in the prompt
(~3.4k tokens): AGENTS.md, .cursor/rules/git.md · 5 rules to read when
relevant: … · 12 skills (~1.1k tokens): build-skill, …`
(`instruction-context-rows.ts`). It is read off the request the engine is
about to send, for every model, and repeats only when the set changes. The
engine nests an inlined rule's own headings under the rule's `## name`
(`nestRuleHeadings`), so a rule whose body opens with `# Title` neither looks
like a new top-level section to the model nor cuts the row's count short.

The `skills` tool's description carries each skill's description as well as
its name, so a model can match a request to a skill whose name does not
repeat the user's words. It asks the model to invoke a skill when the user
wants the skill's task carried out, not whenever a request shares a topic with
it. Skills are loaded from every editor's folder (`.github/skills`,
`.cursor/skills`, `.claude/skills`) whatever editor is running, and a single
`.md`/`.mdc` file placed directly in a skills folder is a skill named after
the file. When a flat file and a `<name>/SKILL.md` folder share a name, the
folder wins, so a short pointer file never stands in for the real skill. The
Skills panel flags a skill with no description, or whose `name:` differs from
its folder. Rule and skill files saved as UTF-16 (PowerShell's default) are
decoded as such (`decodeConfigText`).

Rules stay scoped to the running editor. Files in `.cursor/rules` follow
Cursor's rule types: only `alwaysApply: true` is inlined; a rule with only a
description, or with no frontmatter at all (Cursor's "Manual" rules), is
listed for the model to read when it applies.
