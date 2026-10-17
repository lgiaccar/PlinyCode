# Prompt caching and the token usage panel

Paid Claude models on Pliny bill input that is read from the prompt cache at a tenth of the
normal price, and input written to it at 1.25 times. Where the cache breakpoints sit decides how
much of each request is read back, so it matters most for BalanceAuto and the other paid models.

## Which models are cached

A Pliny model is cached when its catalog entry (`sdk/packages/llms/src/providers/data/pliny-models.json`)
has `"cache_control": true`. That flag gives the model the `prompt-cache` capability, which the
Pliny cache route (`PLINY_ROUTING_METADATA` in `sdk/packages/llms/src/providers/routing/anthropic-compatible.ts`)
requires. A model without it gets no breakpoints at all. Cached entries need `cacheRead` and
`cacheWrite` prices too, or cache reads are costed at $0.

The cached models are the Claude Sonnet and Haiku entries on `snps-aws-bedrock`, plus the Sonnet 4.6
thinking presets on `aws-bedrock-vmodels`, which BalanceAuto's planning route leads with. Before
0.2.2-test.10 the presets were not flagged and never cached.

The free self-hosted models report no cached tokens. They cost nothing, so this only affects
latency.

## Where the breakpoints go

The gateway honours a breakpoint only on a content block of a system, user, assistant or tool
message. It silently drops message-level and top-level markers. `withContentBlockCacheBreakpoints`
places three:

1. **The system prompt**, which caches the tools and system prompt for every call.
2. **The newest message**, usually the latest tool result. The whole request is written, and the
   next call reads all of it back.
3. **The end of the previous step**, the message just before the newest assistant turn. That is
   where the previous call wrote. Marking it again lets the cache find the entry even when a step
   with many parallel tool calls puts it beyond Anthropic's 20-block lookback.

A tool result's breakpoint goes on a text part of its content.

Before 0.2.2-test.10 only user and assistant text was marked. An assistant turn that holds only
tool calls has no text, so the breakpoint fell back to the prompt that opened the turn. Claude
Sonnet 5 nearly always calls tools without narrating. So in a long BalanceAuto turn every call
read only the system prompt from the cache and paid full price for the rest of the turn.

The session logs measured this at about half the input spend on cached Claude calls. One session
paid $5.00 where $1.39 was needed.

## Measuring it

`apps/vscode/scripts/probe-pliny-prompt-cache.ts` replays a growing agent history against the live
gateway, one request per step, through the same transform the extension uses. It prints the
cached, read and written tokens for each call:

```bash
cd apps/vscode
bun --use-system-ca scripts/probe-pliny-prompt-cache.ts --model snps-aws-bedrock/global.anthropic.claude-sonnet-5
bun --use-system-ca scripts/probe-pliny-prompt-cache.ts --legacy   # the placement before the fix
```

With the fix, every call reads everything the previous one sent and writes only the new step. The
legacy placement reads the system prompt and nothing more.

For real conversations, each assistant message in `~/.cline/data/sessions/<id>/<id>.messages.json`
carries `metrics` with input, cache read, cache write and cost. For router models it also has
`metrics.modelId`, the model the router picked for that call.

## The token usage panel

The expanded task header shows a panel under the context bar:

- **Bars:** one stacked bar per LLM call (cache read, cache write, uncached input, output), for
  the last 80 calls.
- **Summary:** the model, call count and cost, input, output and reasoning tokens, and cache
  reads, writes and hit rate.
- **Model chips:** shown when the conversation used more than one model, as FreeAuto and
  BalanceAuto do (they pick a model per call). There is one chip per model, with its call count.
  Picking a chip narrows the summary to that model's calls and dims the other bars. **All models**
  shows them all again.

Hovering a bar switches the summary to that call. The hit rate is cache reads over all prompt
tokens: uncached input plus cache reads plus cache writes.

The panel's header row (**Token usage** · calls · cost · hit rate) folds it away and keeps those
totals in view. It starts open; the choice is remembered per webview in `localStorage`.

The panel reads the `api_req_started` rows, so its bars and summary cover the main agent's calls.
Usage from elsewhere arrives as `subagent_usage` rows, each tagged with its `source`, and the
summary shows one line per source under it, with a small label: **Sub-agents** (one row per batch
of `spawn_agent` runs), **Advisor** (one row per `ask_advisor` call) and **Compaction** (the
summarizer's call), each with its row count when there is more than one, its tokens and its cost.
The task header's total adds them all. Each `api_req_started` row carries `modelId` and
`reasoningTokens` when known:

- **The routed model:** `routed-agent-model.ts` tags the usage event with the model that served
  the call. The tag travels through `AgentTokenUsage.modelId` into the saved message metrics and
  the live `usage` event.
- **Reasoning tokens:** the provider's count is carried the same way.

Conversations saved before this change show the router's own name (FreeAuto, BalanceAuto) instead
of the routed model.
