# Context compaction

How a conversation is kept inside the model's input limit: when compaction runs, what each strategy keeps, what happens when the provider still rejects the request, what the summarizer costs, and what the context bar shows. The code is in [sdk/packages/core/src/extensions/context/](../sdk/packages/core/src/extensions/context/compaction.ts) (`compaction.ts`, `agentic-compaction.ts`, `basic-compaction.ts`, `compaction-shared.ts`), with the extension's manual `/compact` in [sdk-compaction.ts](../apps/vscode/src/sdk/sdk-compaction.ts).

## When it runs

Before every model call, the engine estimates the whole request (system prompt, messages and tool definitions) at three characters per token (`CHARS_PER_TOKEN`), with every image or other binary payload counted at a fixed `IMAGE_TOKEN_ESTIMATE` of 1,600 tokens rather than as its base64 text. Compaction runs when the request reaches 90% of the model's input limit (`COMPACTION_TRIGGER_RATIO`), or the share set in `plinycode.compaction.threshold` (0.1 to 0.95). The setting is read before every model call, so a change applies to the running conversation. The limit is the model's `maxInputTokens`, or 90% of its context window when only that is known; the Pliny catalog sets the limit to the window, FreeAuto uses a 92k budget so the whole free pool stays routable ([pliny-free-auto-router.md](pliny-free-auto-router.md)), and BalanceAuto 128k.

The budget is translated into estimate units before it is compared, as described under "Calibrated estimate" below. A model that packs fewer characters into a token than three gets a smaller budget, and one that packs more gets a larger one.

The setting is auto-condense (`useAutoCondense`), on by default; the strategy is `compactionStrategy`, `agentic` by default. A routed model (FreeAuto, BalanceAuto) follows the same setting and only attaches its free summarizer.

## Calibrated estimate

Three characters per token over-counts English and code on most tokenizers, which made compaction run early, and under-counts dense content on some. The engine therefore learns a ratio per model from the counts providers report, with no tokenizer dependency (`tokenCalibration` in [token-calibration.ts](../sdk/packages/shared/src/llms/token-calibration.ts)):

- **Learning.** After each call that reports real usage, the provider layer ([ai-sdk-usage.ts](../sdk/packages/llms/src/providers/ai-sdk-usage.ts), `observeTokenCalibration`) divides the request's estimated text characters by the reported input tokens, less 1,600 per image. The reported count includes cache reads and writes, because the whole request was tokenized. The ratio goes into an exponential moving average (weight 0.2), kept under two ids: the model that served the call, and the session's own model when that differs. For FreeAuto and BalanceAuto, the second is a blend of the models they route to.
- **Guards.** Calls under 1,000 input tokens and ratios outside 1 to 10 are ignored, as they come from a provider counting only uncached input or from a truncated request. The average is clamped to 2.0 to 5.0 characters per token. A model with fewer than three observations, or none, keeps three characters per token. At most 200 models are kept, and the least recently seen ones are dropped first.
- **Persistence.** The extension loads `<dataDir>/token-calibration.json` (`~/.cline/data/` unless `CLINE_DATA_DIR` says otherwise) at startup and writes it a few seconds after calls teach it something (`persistTokenCalibration` in core). Each write first merges the file, keeping each model's most recent entry, so windows that run side by side do not overwrite each other.
- **Compaction.** The budget is divided by the larger of two factors. The calibration factor is 3 divided by the model's ratio: 1 when the model has no calibration, below 1 for a model that packs more characters into a token. The underestimate factor is the provider's count for the previous request divided by the estimate of the current one; it is direct evidence that this conversation's content is denser than the average. The result is capped at four. Before calibration, the underestimate factor could only tighten the budget, never loosen it. It keeps that role for a calibrated model; it no longer has a floor of 1, because the calibration factor now sets the floor. Every other number (trigger, target, message costs) stays in estimate units, as before.
- **The context bar.** When a provider reports no usage, the fallback estimate the bar shows (with a `~`) uses the calibrated ratio, as does the raw context breakdown.

## The strategies

- **Agentic.** Keeps about 20,000 tokens of recent messages (`DEFAULT_PRESERVE_RECENT_TOKENS`), never cuts inside a tool call and its result, and never before the latest message the user typed. A model writes a summary of what it cut, which replaces those messages as a `Context summary:` message the chat does not show. The summarizer is the session's model, or the free `utility.summarizer` of the router's rules on FreeAuto and BalanceAuto.
- **Basic.** No model call. Keeps every message the user typed, folds older turns to their final answer, and can trim inside the latest turn. The dropped work is listed in a system notice (files read and edited, commands run, the last assistant texts).
- **The summary follows the newest request.** The summarizer is shown the newest message the user typed (`extractLatestUserRequest`) and told to write the summary's goal from it, not from the previous summary, which it is told may be stale. Steps count as done only when a tool result or an edit in the conversation shows them; anything the previous summary claimed that the conversation does not show goes under `Unverified`. The summary message ends with a line saying the user's later messages take precedence over its goal. A 2026-10-17 session kept the goal "fix a compile error" through a compaction and spent a turn looking for an error the user had stopped asking about.
- **Agentic, then basic.** The agentic strategy folds nothing twice: once everything before the latest typed prompt is in a summary, it returns nothing. Before, the request then went out as it was until the provider rejected it. Basic compaction now runs in that case, so the latest turn is trimmed inside. A summary that leaves the request over the trigger is not retried at once: the next model call compacts again, finds nothing new to fold, and basic runs then. The same happens when the summarizer answers with no text.
- **Still too large.** If one typed message is by itself over the limit, basic compaction, which keeps every typed message whole, cannot help either. The chat says so (`⚠ The context is still over the model's input limit after compaction …`) instead of leaving the provider's rejection to explain it.

## Pruning before compaction

Before a request is sent, and before compaction sizes it, `pruneStaleContext` ([stale-context.ts](../sdk/packages/core/src/session/services/messages/stale-context.ts)) prunes what no longer earns its place. It runs on the request copy after `dropPriorTurnReasoning`, in `prepareMessagesForModelRequest` and in the sizing path of the orchestrator; the stored transcript is never changed. `execution.staleContextPruning` on the agent config overrides its numbers or, set to `false`, turns it off.

What it prunes, measured on a session whose request went from 260k to 65k characters ten times in seven turns:

- **Tool results from earlier user turns** over 2,000 characters become a stub naming the tool, what was asked and the size (`[read_files output elided (48212 chars) — earlier turn; it was: "…"; call the tool again if you need it]`). A structured entry keeps its `query`, `success` and `error`. Error results, and results carrying an image, are kept.
- **Aged tool results of the current turn** over 8,000 characters are middle-cut to a 1,500-character head and tail.
- **The deliberation before a tool call** in an earlier turn is cut to its last 600 characters, where the step taken is stated. Models that reason in their content (Kimi K2.6 on the gateway has no reasoning channel) write tens of thousands of characters of "Wait… Actually…" before each call, as ordinary text that `dropPriorTurnReasoning` cannot see. Final answers, messages with no tool call, are kept whole. Aged in-turn text over 6,000 characters gets the same cut.
- **The input of a failed tool call** whose JSON exceeds 6,000 characters has its long strings replaced by `<elided N chars>`: an `editor` call rejected for its size used to leave the whole `new_text` in the history.

The latest user message, reminders, compaction summaries and the last iterations of the current turn are never touched.

**Prompt caching.** The earlier-turn rules depend only on where the current turn starts, so a message changes once, on the first call of the next turn, when the request ends in a new user message anyway. The in-turn rules would move one message per call on a rolling window and invalidate a cached prefix on every call; instead the aged boundary advances in blocks of eight iterations: the first sixteen calls of a turn send an unchanged prefix, the seventeenth cuts iterations 1-8, the twenty-fifth cuts 9-16. A block that was cut stays cut, so the pass is deterministic for a given history.

## Overflow recovery

A provider that rejects the request as too large gets one basic compaction and a retry per run, and only when the retried request is smaller. A second rejection in the same run ends it.

## What the summarizer costs

The summarizer's call is a model call like any other. Its tokens and cost come back with the compaction result (`summarizerUsage`), are kept in the summary message's metadata, and are shown as a usage row with `source: "compaction"`, the row type that also carries sub-agent and advisor cost, so the task header, the conversation budget and the history record include it. A reopened conversation rebuilds the row from the summary message, and a task running in the background, which has no rows, adds the notice's usage to its history record. The engine's own usage leaves the summarizer out, so the history record keeps it under `extraUsage`, beside the advisor's ([advisor-tool.md](advisor-tool.md), "Cost and the conversation budget"). On the routers the summarizer is a free model, and the row's cost is zero.

## The context bar

The task header's bar divides the last request's tokens by the model's context window. Compaction runs at 90% of the model's input limit by default, which on FreeAuto is about a third of the advertised window. The bar therefore carries a marker where auto-condense runs (`autoCompactThreshold` in [ContextWindow.tsx](../apps/vscode/webview-ui/src/components/chat/task-header/ContextWindow.tsx)), and the hover card explains it.

**Setting the threshold from the bar.** While auto-condense is on, the bar is a slider. Clicking it sets `plinycode.compaction.threshold` at that point: the click position, a share of the window, is turned into a share of the input limit (`compactionThresholdAt` in [autoCompactThreshold.ts](../apps/vscode/webview-ui/src/components/chat/task-header/autoCompactThreshold.ts)), rounded to a whole percent and clamped to 10% to 95%. With the bar focused, the arrow keys move the threshold by 5%, and Home and End jump to 10% and 95%. The marker moves at once and the setting is saved to the user's VS Code settings, which the extension reads before the next model call. A click past the input limit, on FreeAuto's right two thirds for example, sets 95%.

**The context breakdown.** The hover card splits the last request by source. The provider's usage report computes the split ([context-breakdown.ts](../sdk/packages/shared/src/llms/context-breakdown.ts)) and scales it so the parts add up to the reported prompt size. Each bucket comes from:

| Bucket | Source |
| ------ | ------ |
| System Prompt | the system prompt, less the rules and the memory section |
| Rules | the rules the session composed into the system prompt, passed as request metadata (`contextSources.rulesText`) |
| Memory | the `# Memory` section the extension appended to the system prompt ([memory.md](memory.md)), passed as `contextSources.memoryText`; counted only when the prompt contains it |
| Tools | the serialized tool definitions sent with the request (name, description, input schema), MCP tools included, less the `skills` tool's listing |
| Skills | the `skills` tool's listing of skills (its description from `Available skills:` on), the results of `skills` tool calls, and built-in skill bodies a slash command pasted (`/deep-planning`) |
| Workflows | workflow bodies a slash command pasted into a user message. The extension passes every known workflow body (`contextSources.workflowTexts`), and each one found in a user message counts here |
| Conversation | the rest of the messages: text, reasoning, tool calls and results |
| Other | images, attached files and generated media |

The host-side sources (memory, pasted bodies) are read before every model call through `CoreSessionConfig.contextSources`, set in [sdk-session-config-builder.ts](../apps/vscode/src/sdk/sdk-session-config-builder.ts). The engine adds the rules. The router's addendum and the preferred-language line stay in System Prompt.

## Prompt caching

Only catalog models flagged for it get cache breakpoints: on the system prompt, the newest message (usually the latest tool result) and the end of the previous step. [prompt-cache.md](prompt-cache.md) explains the placement, why tool-only assistant turns used to defeat it, and how it was measured.

What else changes the cached prefix: a mode switch (the mode instructions are in the system prompt), editing a rules file (rules are re-read on every run), removing an earlier turn's reasoning, rewriting superseded file reads, compaction itself, and a change to the MCP tool list. The git snapshot, the memory section and the date are pinned per conversation so a rebuild does not change them ([environment-context.md](environment-context.md), [memory.md](memory.md)).
