# November 6, 2026 Pliny model update

Preparation branch: `lgiaccar/nov6-model-update`. This is a catalog and migration
change, not a release or a scheduled switchover. Installing this branch activates
the migration immediately; the replacement GLM deployments already respond.

The platform announcement retires `snps-provider-vmodels/glm-5.2` and
`snps-provider-internal-tests/glm-5-2` by **November 6, 2026 at 09:00 PST
(17:00 UTC / 18:00 Budapest)**. Both resolve to
`snps-provider-vmodels/glm-5.3`. The paid `google-vertex/glm-5.2` stays available
for explicitly selected cloud GLM-5.2 use and never becomes a FreeAuto fallback.

## Availability and verification

Model IDs and types come from the supplied Pliny platform announcement. The
[internal model catalog](https://pliny.internal.synopsys.com/model-catalog) was
not accessible to the browsing tool. Small authenticated gateway probes on
November 4 verified the tool calls and limits below. These are smoke checks,
not performance rankings, long-context acceptance tests or coding evaluations.

| Model ID | Type | Preparation status |
| --- | --- | --- |
| `snps-provider-vmodels/kev-27b` | Decision | Recorded separately; excluded from chat and agent pools |
| `snps-provider-vmodels/laya` | Decision | Recorded separately; excluded from chat and agent pools |
| `snps-provider-vmodels/glm-5.3` | Chat | Tool call observed; gateway reports 524,288-token window |
| `snps-provider-vmodels/glm-5-3-flash` | Chat | Tool call observed; gateway reports 512,000-token window |
| `snps-provider-vmodels/nvidia-nemotron-3-5-super-vl-120b-a12b` | Chat | Tool call observed; gateway reports 128,000-token window; vision not verified |
| `snps-provider-vmodels/qwen3.8-27b` | Chat | HTTP 403: not authorized or nonexistent; staged but hidden pending verification |
| `snps-aws-bedrock-frontier/global.anthropic.claude-opus-5-5` | Chat | HTTP 403: not authorized or nonexistent; staged but hidden pending verification |
| `snps-aws-bedrock-frontier/global.anthropic.claude-opus-5` | Chat | HTTP 403: not authorized or nonexistent; staged but hidden pending verification |
| `snps-aws-bedrock/global.anthropic.claude-sonnet-5` | Chat | Already in catalog; existing metadata retained |
| `snps-aws-bedrock/global.anthropic.claude-sonnet-5-5` | Chat | Tool call observed; added without guessed prices or controls |
| `snps-aws-bedrock/global.anthropic.claude-haiku-5-5` | Chat | Tool call observed; added without guessed prices or controls |
| `snps-google-gcp/gemini-3.8-flash` | Chat | Tool call observed; added without guessed prices or controls |
| `snps-google-gcp/gemini-3.7-flash` | Chat | Already in catalog; existing metadata retained |
| `azure-openai/gpt-5.6-luna` | Chat | Already in catalog; existing metadata retained |
| `azure-openai/gpt-5.6-terra` | Chat | Already in catalog; existing metadata retained |
| `google-vertex/glm-5.2` | Chat | Already in catalog; remains paid and unpriced |

Deployment windows came from rejection of a deliberately oversized
`max_tokens: 1000000` request, whose error reports `max_model_len`. No context
limit, reasoning control, image capability, cache behavior, parameter count or
price is copied from an older deployment to a new one. New hosted entries use
the existing unverified-limit defaults (200,000 context / 64,000 output) until
their limits are confirmed. Unpriced models still count as paid.

The primary `snps-provider/GLM-5.2` ID is not one of the announcement's two
explicit migration rows. It is retained pending clarification, including in
the catalog-derived fallback pool of nonexclusive profiles. Main and
huge-context routes now use GLM-5.3 and Flash. Confirm whether the primary
deployment also retires before shipping; if it does, retire and alias it too.

### GLM-5.3 is already functional

Both new GLMs passed six streamed tool round trips through PlinyCode's compiled
gateway adapter on November 4: one round trip each in default, quick
(`reasoning.enabled: false`) and planning (`enabled: true, effort: high`)
configurations. Every run produced valid `read_fixture` arguments, accepted a
tool result containing a fresh random word, and returned that word correctly.
These six scenarios made twelve successful streamed requests. The observed
round-trip times ranged from 1.1 to 45 seconds; this is not a latency benchmark.
There is no availability reason to wait until November 6 to switch these IDs.

Separate reasoning probes confirmed both reason by default and accept
`reasoning_effort: high`. The old `chat_template_kwargs.enable_thinking: false`
switch is **not reliable** on these deployments: GLM-5.3 emitted reasoning
inside ordinary content with a closing `</think>`, and Flash continued emitting
reasoning deltas. Accordingly, the new catalog records only `defaultOn: true`
and does not copy the GLM-5.2 off-switch. Quick routes retain default reasoning.

## Migration behavior

- Default FreeAuto keeps Kimi first, followed by GLM-5.3 and GLM-5.3 Flash.
  Smart leads with GLM-5.3, then Flash. Huge-context routes use those two GLMs.
  Paid main routes retain their existing model order.
- Saved Plan/Agent selections use the existing activation migration. Session
  creation, resumed conversations and concrete sub-agent calls also resolve
  the retiring IDs. Favorites use the existing canonical-ID cleanup.
- Global/workspace rules and Settings router orders, route overrides and
  utility models canonicalize the retiring IDs before deduplication. A list
  containing both retiring replicas becomes one GLM-5.3 candidate. Edited
  rules files are not rewritten; their effective rules are migrated on read.
- Untouched generated rules files follow the existing seed-upgrade mechanism.
- Existing compaction budgets are retained. Historical September probe reports
  remain unchanged; their GLM-5.2 measurements do not describe GLM-5.3.
- Per-model tuning for an old ID is not copied to GLM-5.3: old reasoning
  controls and user context overrides are not evidence about the replacement.

## Before release

- Recheck Qwen and both Opus IDs with an authorized key. Only mark `tool_call`
  after a real tool call succeeds; their staged entries are intentionally hidden.
- Clarify the primary `snps-provider/GLM-5.2` retirement scope.
- Verify streaming tool calls and tool-result continuation in a real extension
  session, including a saved retiring selection and custom router rules.
- Investigate a reliable GLM-5.3/Flash reasoning-off control, new model image input and caching,
  and hosted deployment limits/prices. Add only measured or catalog-confirmed
  fields. The new models currently retain their default reasoning behavior.
- Exercise a long routed conversation and failover with the replacement GLMs.
- Complete CI and the normal [release process](releasing.md) before publishing.

The focused probes used the existing `PLINY_API_KEY` with normal TLS validation
through Windows system certificate trust. Scratch scripts and raw results are
under the gitignored `ai_output/nov6-model-update/`; no key is stored there.

Local validation used Bun 1.3.14 and Node 26.8.1 (the installed runtime): engine
build, all-package type checks, 47 model/thinking tests, 548 extension/router
tests, formatting, documentation links and unused production code checks.
Desktop extension-host tests and CI remain part of release validation.
