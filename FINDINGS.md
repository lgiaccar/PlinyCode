# pliny-code — Research Findings (carried over from prior session)

> Source session: `2a2c4bdf-f0fd-449d-82c6-dd71366a2b86` (project `d--dev0-GPUSurfer`), 2026-09-20.
> Every claim below was **verified live** against the Pliny gateway, not read from docs.
> Re-runnable proof lives in `research/probes/`.

## Goal
A Cursor/VS Code coding-agent extension (Cline/Continue-like), internal models only via Pliny.
No legacy providers, no user accounts, no non-VS Code surfaces.

Requirements: ask/agent/plan modes · conversation compaction · multi-session ·
conversation history · model picker incl. in-house models.

## Verdict
**Fork Cline. Do not build from scratch.**
Pliny is an OpenAI-compatible gateway, so Cline's OpenAI-compatible provider is ~90% of the work.

- Working internal prototype: **1–2 weeks**
- Production, team-wide: **5–8 weeks**
- From scratch: 6–9 months (not worth it)

Cline over Continue: Continue's config-driven design fights you when stripping to one
provider; Cline's task loop is more directly forkable.

## Pliny gateway facts (verified)
- Base URL: `https://snps-inference.internal.synopsys.com/api/llm`
- Auth: `Authorization: Bearer $PLINY_API_KEY` (a ~1040-char PAT, not a short key)
- TrueFoundry-backed (`X-TFY-*` headers, `server: istio-envoy`)
- Optional headers: `X-TFY-METADATA`, `X-TFY-LOGGING-CONFIG`

| Capability | Status |
|---|---|
| `/chat/completions` OpenAI shape | verified 200 |
| Tool calling | verified: Claude Sonnet 4.6, GPT-5.2, Qwen3-Coder-480B, Gemini 3.1, Kimi-K2.6 |
| Streaming + incremental tool-call deltas | verified, 7–11 chunks, TTFT 1.1–1.9 s |
| Full agent round-trip (tool result -> turn 2) | verified on all 4 model families |
| Extended thinking | Anthropic `thinking` -> `reasoning_content`; Azure `reasoning_effort` |
| Usage + **per-call `costInUSD`** | returned by gateway |

## The four challenges (each found by testing, not guessing)

### 1. Node rejects the corporate TLS cert — day-one blocker
`curl` works (Windows schannel trusts the CA); **Node fails** with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`. A VS Code extension *is* Node.
`node --use-system-ca` fixes it at the CLI, but an extension cannot pass node flags:
bundle the CA / set an explicit https agent. Cheap to fix, very confusing to debug cold.

### 2. Prompt caching is opt-in on Anthropic — a 10x cost difference
Measured on a 27k-token prompt (`research/probes/cache_test.js`):

| Setup | call 1 | call 2 |
|---|---|---|
| no `cache_control` | $0.0811 | $0.0811 (no caching at all) |
| with `cache_control` | $0.1014 | **$0.0082** |
| Azure gpt-5.2 (auto-caches) | $0.0426 | $0.0045 |

Anthropic requires explicit `cache_control: {type:"ephemeral"}` blocks; Azure auto-caches.
Against the **$200/month per-user budget cap**, an agent replaying long conversations
without this burns budget ~10x faster. Treat cache-block placement as a core feature.

### 3. `/models` is not a capability list
Returns 102 entries with only `id`/`object`/`created`/`owned_by` — no context window,
no pricing, no tool-support flag. It also **ignores per-user authorization**:
`azure-openai/gpt-5.5` is listed but returns **403** for this user.
Self-hosted models can return **503 "no healthy upstream"** (hit twice during testing).
=> Hand-maintain a capability table; degrade gracefully on 403/503.

### 4. Retry is yours to build
Docs are explicit: 429s carry **no `Retry-After` header**. Need exponential backoff
with jitter. Read `x-tfy-applied-configurations` to report *which* limit was hit.
Budget limits also exist separately from rate limits (calendar-period reset).

## Recommended plan changes
- **Keep an Anthropic-native path.** Claude via Bedrock is the strongest coding model and
  `cache_control` is Anthropic-shaped; going strictly OpenAI-compatible forfeits the 10x win.
- **Surface cost in the UI.** Gateway hands you `costInUSD` free; with a $200 cap this is a
  real feature, cheaply built.
- **Gemini needs a normalization shim:** returned `finish_reason: "stop"` (not `tool_calls`)
  with a `__thought__` blob embedded in the tool-call id. Shim it or drop Gemini from v1.
- **Plan for PAT expiry.** Docs flag enforced expiration + periodic rotation as upcoming.

## Cline scale (measured on HEAD @ 9a2512b)
~370k LOC total, but the part you delete is the biggest part:

| Area | LOC | Fate |
|---|---:|---|
| `sdk/packages/llms/` (62 providers) | 202,440 | **delete almost all** |
| `sdk/packages/core/` | 104,283 | keep core, drop hub/cron/account |
| `apps/vscode/` | 29,064 | keep, strip auth/telemetry |
| `apps/cli/`, `apps/cline-hub/` | 94,071 | drop |
| compaction (`core/src/extensions/context/`) | ~7,518 | **keep — this is your compaction req** |

All four requirements already exist upstream (plan/act modes, compaction, multi-session,
history, model picker).

**Caveat:** Cline HEAD is a monorepo mid-refactor. Budget for rebase pain, or pin a
release tag and cherry-pick.

## Known-good model ids (verified working for this user)
- `snps-aws-bedrock/aws-claude-sonnet-4.6`  <- best default
- `snps-aws-bedrock/global-anthropic-claude-haiku-4-5-20251001-v1-0`  <- cheap/fast
- `azure-openai/gpt-5.2`
- `snps-provider/qwen3-coder-480b-a35b-inst-fp8`  <- self-hosted, no cost field
- `snps-google-gcp/gemini-3.1-pro-preview`  <- needs shim
- `azure-openai/Kimi-K2.6`

403 for this user: `azure-openai/gpt-5.5`, `snps-aws-bedrock/aws-claude-opus-4.8`,
`snps-provider-exception/glm-5-1-fp8`

## Re-running the proof
```bash
cd research/probes
node --use-system-ca tool_test.js   "snps-aws-bedrock/aws-claude-sonnet-4.6"
node --use-system-ca stream_test.js "snps-aws-bedrock/aws-claude-sonnet-4.6"
node --use-system-ca roundtrip.js   "snps-aws-bedrock/aws-claude-sonnet-4.6"
node --use-system-ca cache_test.js  "snps-aws-bedrock/aws-claude-sonnet-4.6" ctl
node --use-system-ca reason_test.js "snps-aws-bedrock/aws-claude-sonnet-4.6" anthropic
```
Requires `PLINY_API_KEY` in env. `--use-system-ca` is mandatory (see challenge 1).

## Next step (was offered, not yet done)
Prototype the Pliny provider against a Cline fork to de-risk TLS + caching.
