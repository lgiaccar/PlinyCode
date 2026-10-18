# Model tuning: thinking, effort and context size

The sliders button under the prompt box, left of the model picker, tunes the selected model:

- **Thinking:** Default, On or Off.
- **Effort:** Default, Low, Medium or High.
- **Context:** Full, 128k, 64k or 32k.

A tuning is saved per model id and applies to every conversation on that model, in every window, until it is changed back. The button is drawn in the link color while the model has a tuning, and the model picker's details card lists the tuning ("Tuned: effort high, 64k context").

## What is offered

A control is only shown when it changes something on that model. The reasoning controls come from the model's measured switches, the `thinking` entry of its catalog record (`pliny-models.json`). Both pools are measured:

- the self-hosted pool by `probe-pliny-free-models.ts --thinking` (results in [pliny-free-auto-thinking.md](pliny-free-auto-thinking.md));
- the hosted pool by `probe-pliny-hosted-thinking.ts` (below).

The rules for each control (`modelTuningOptions` in [model-tuning.ts](../apps/vscode/src/shared/model-tuning.ts)):

- **Off** is offered when the model reasons by default and has a measured off-switch.
- **On** is offered when it does not reason by default and `reasoning_effort` turns reasoning on.
- **Effort** is offered when `reasoning_effort` is the model's on-switch. "On" without a level asks for medium.
- **Context** offers the presets below the model's own budget. The tuned budget can only lower the model's own budget, never raise it, and is never below 16k.

Models with no measured switch (Claude Sonnet 5 and Haiku 4.5 among them) show only the context row. A note under it says that their reasoning cannot be changed through the gateway.

**Routers get the context row only.** FreeAuto and BalanceAuto choose reasoning per call from their routes:

- every plan-mode turn thinks;
- quick and coding turns don't;
- the fast profile never does.

See [pliny-free-auto-router.md](pliny-free-auto-router.md) for the routes. A context tuning lowers a router's own budget (92k, 64k for auto-free-fast, 128k for BalanceAuto).

## How it is applied

The tuning lives in the global state key `modelTuning`, a map from model id to `{ thinking?, effort?, maxInputTokens? }`. The webview writes it through the `ModelsService.setModelTuning` RPC ([setModelTuning.ts](../apps/vscode/src/core/controller/models/setModelTuning.ts)). The RPC replaces the model's entry, drops invalid fields, and removes the entry when nothing is left.

When a session is built (`buildSessionConfig` in [cline-session-factory.ts](../apps/vscode/src/sdk/cline-session-factory.ts)):

- **Reasoning.** The model's tuning sets the session's `thinking` and `reasoningEffort`, ahead of the provider-wide reasoning setting from Settings. Off sends `thinking: false`, and the engine encodes it with the model's measured off-switch. An effort level sends `reasoning_effort`. Router ids are skipped.
- **Context.** The session model's entry in `knownModels` is copied with `maxInputTokens` lowered to the tuned budget. Compaction budgets against that entry ([context-compaction.md](context-compaction.md)), so the conversation compacts sooner. The context bar's compaction marker follows the same budget (`TaskHeader`).

Changing the tuning of the model the open conversation runs on rebuilds its session once it is idle, keeping the conversation, the same way a Pliny API key change does (`handleModelTuningChanged`). Switching the conversation to or from a tuned model does the same.

## Hosted models: what the gateway honours

Measured on 2026-10-18 with `apps/vscode/scripts/probe-pliny-hosted-thinking.ts` (two runs per variant, a short reasoning question):

| Model | Default | `reasoning_effort` low / high | `reasoning_effort: none` | Catalog entry |
| --- | --- | --- | --- | --- |
| Claude Sonnet 4.6 | no reasoning | on; 99-156 vs 490-575 reasoning chars | no reasoning | off by default, on via `reasoning-effort` |
| GPT-5.2 | no reasoning (0 tokens) | on; 56-81 vs 133-197 reasoning tokens | no reasoning | off by default, on via `reasoning-effort` |
| GPT-5.6 Terra | reasons (~55 tokens) | little change | off | on by default, off via `reasoning-effort-none` |
| Gemini 3.5 Flash | reasons (~400-540 tokens) | low cuts it to ~180 | still reasons | on by default, effort via `reasoning-effort` |
| Kimi K2 Thinking | reasons (~3k chars) | no change | off | on by default, off via `reasoning-effort-none` |
| GLM-5 (Vertex) | reasons | no clear change | **400** (only minimal/low/medium/high/max) | on by default, no switch |
| Claude Sonnet 5 | no visible reasoning | no change | no change | none |
| Claude Haiku 4.5 | no visible reasoning | no change | no change | none |

Haiku 4.5 does think when sent an Anthropic-style `thinking: { type: "enabled", budget_tokens }` field. That field is not part of the measured encodings (`PlinyThinkingOn`), so Haiku has no entry yet. The Sonnet 4.6 thinking presets are separate model ids, as before.

Before the hosted models had entries, a provider-wide reasoning setting was sent to them unchecked. Now they get only the switches above, the same rule the self-hosted pool follows. On BalanceAuto, the `plan-and-reasoning` route turns GPT-5.2's reasoning on at high effort when the call fails over to it.

To measure again, or to measure a new hosted model:

```sh
PLINY_API_KEY=... bun --use-system-ca apps/vscode/scripts/probe-pliny-hosted-thinking.ts azure-openai/gpt-5.2 snps-aws-bedrock/aws-claude-sonnet-4.6
```

Then copy the verdict into the model's `thinking` entry in `sdk/packages/llms/src/providers/data/pliny-models.json`.
