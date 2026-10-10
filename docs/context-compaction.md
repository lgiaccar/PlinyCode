# Context compaction

How a conversation is kept inside the model's input limit: when compaction runs, what each strategy keeps, what happens when the provider still rejects the request, what the summarizer costs, and what the context bar shows. The code is in [sdk/packages/core/src/extensions/context/](../sdk/packages/core/src/extensions/context/compaction.ts) (`compaction.ts`, `agentic-compaction.ts`, `basic-compaction.ts`, `compaction-shared.ts`), with the extension's manual `/compact` in [sdk-compaction.ts](../apps/vscode/src/sdk/sdk-compaction.ts).

## When it runs

Before every model call, the engine estimates the whole request (system prompt, messages and tool definitions) at three characters per token (`CHARS_PER_TOKEN`), with every image or other binary payload counted at a fixed `IMAGE_TOKEN_ESTIMATE` of 1,600 tokens rather than as its base64 text. Compaction runs when the estimate reaches 90% of the model's input limit (`COMPACTION_TRIGGER_RATIO`). The limit is the model's `maxInputTokens`, or 90% of its context window when only that is known; the Pliny catalog sets the limit to the window, FreeAuto uses a 92k budget so the whole free pool stays routable ([pliny-free-auto-router.md](pliny-free-auto-router.md)), and BalanceAuto 128k. When the provider counted the previous request higher than the estimate, the budget is scaled down by that ratio, at most four times.

The setting is auto-condense (`useAutoCondense`), on by default; the strategy is `compactionStrategy`, `agentic` by default. A routed model (FreeAuto, BalanceAuto) follows the same setting and only attaches its free summarizer.

## The strategies

- **Agentic.** Keeps about 20,000 tokens of recent messages (`DEFAULT_PRESERVE_RECENT_TOKENS`), never cuts inside a tool call and its result, and never before the latest message the user typed. A model writes a summary of what it cut, which replaces those messages as a `Context summary:` message the chat does not show. The summarizer is the session's model, or the free `utility.summarizer` of the router's rules on FreeAuto and BalanceAuto.
- **Basic.** No model call. Keeps every message the user typed, folds older turns to their final answer, and can trim inside the latest turn. The dropped work is listed in a system notice (files read and edited, commands run, the last assistant texts).
- **Agentic, then basic.** The agentic strategy folds nothing twice: once everything before the latest typed prompt is in a summary, it returns nothing. Before, the request then went out as it was until the provider rejected it. Basic compaction now runs in that case, so the latest turn is trimmed inside. A summary that leaves the request over the trigger is not retried at once: the next model call compacts again, finds nothing new to fold, and basic runs then. The same happens when the summarizer answers with no text.
- **Still too large.** If one typed message is by itself over the limit, basic compaction, which keeps every typed message whole, cannot help either. The chat says so (`⚠ The context is still over the model's input limit after compaction …`) instead of leaving the provider's rejection to explain it.

## Overflow recovery

A provider that rejects the request as too large gets one basic compaction and a retry per run, and only when the retried request is smaller. A second rejection in the same run ends it.

## What the summarizer costs

The summarizer's call is a model call like any other. Its tokens and cost come back with the compaction result (`summarizerUsage`), are kept in the summary message's metadata, and are shown as a usage row with `source: "compaction"`, the row type that also carries sub-agent and advisor cost, so the task header, the conversation budget and the history record include it. A reopened conversation rebuilds the row from the summary message. On the routers the summarizer is a free model, and the row's cost is zero.

## The context bar

The task header's bar divides the last request's tokens by the model's context window. Compaction runs at 90% of the model's input limit, which on FreeAuto is about a third of the advertised window, so the bar carries a marker where auto-condense runs (`autoCompactThreshold` in [ContextWindow.tsx](../apps/vscode/webview-ui/src/components/chat/task-header/ContextWindow.tsx)), and the hover card explains it. The hover card's context breakdown shows the rules apart from the rest of the system prompt: the engine passes the rules it composed as request metadata (`contextSources`), which the provider's usage report uses. Skills and workflows pasted by a slash command are not broken out yet.

## Prompt caching

Only catalog models flagged for it get cache breakpoints: one at the end of the system prompt and one on the newest user or assistant text block ([anthropic-compatible.ts](../sdk/packages/llms/src/providers/routing/anthropic-compatible.ts)). In a tool loop where the assistant writes no text between calls, the second breakpoint stays on the last text and every tool result since is sent uncached on each step. The gateway drops a marker on anything but a text block, so marking a tool-call message means adding a one-character text to it on the wire; `PLINYCODE_CACHE_MARK_TOOL_CALLS=1` turns that on for measuring with the router's call log before it becomes the default.

What else changes the cached prefix: a mode switch (the mode instructions are in the system prompt), editing a rules file (rules are re-read on every run), removing an earlier turn's reasoning, rewriting superseded file reads, compaction itself, and a change to the MCP tool list. The git snapshot, the memory section and the date are pinned per conversation so a rebuild does not change them ([environment-context.md](environment-context.md), [memory.md](memory.md)).
