# PlinyCode — Research Findings (carried over from prior session)

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

### 3. `/models` is not a capability list — and it is also INCOMPLETE
Returns 102 entries with only `id`/`object`/`created`/`owned_by` — no context window,
no pricing, no tool-support flag. It **ignores per-user authorization**
(`azure-openai/gpt-5.5` is listed but 403s for this user), and — discovered via the
Kilo config — it **omits models that actually work**: `snps-provider/kimi-k2.6`,
`snps-provider/GLM-5.2`, `snps-provider-internal-tests/glm-5-2`,
`snps-provider-vmodels/glm-5.2` and `snps-aws-bedrock/global.anthropic.claude-sonnet-5`
all return 200 with tool calls but are absent from or differ from the published list.

=> **Never derive the picker from `/models` alone.** Use the verified catalog in
`research/pliny-models.json` (measured, not guessed) and degrade gracefully on 403/503.

**Good news:** the gateway reports the *true* context window in its error text when you
over-request `max_tokens`, e.g. `max_model_len=max_total_tokens=512000`. That is how
the catalog limits were measured, and it means the table can be regenerated automatically
rather than hand-maintained (`research/probes/ctxprobe.js`).

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

**Correction (2026-09-20, post-fork-import):** the "62 providers" framing above is now
stale. At the same commit (`9a2512bb9835869d74774da99708a7f9d80b0fe8`, forked into this
repo — see the `fork:` commit), the provider layer is a thin adapter over **Vercel AI
SDK** (`@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, etc.), and the per-vendor split
lives in `sdk/packages/llms/src/providers/vendors/` as **12 files**, not 62 standalone
providers. The repo is also **Bun workspaces** (`bun@1.3.13` pinned, `node >=22`), not
plain npm, and `apps/vscode` requires a protobuf/gRPC codegen step (`buf`) before it
compiles. The import kept only `vendors/openai-compatible.ts` and `vendors/anthropic.ts`
and dropped `bedrock.ts`, `cline.ts`, `community.ts`, `google.ts`, `minimax-thinking.ts`,
`mistral.ts`, `ollama.ts`, `openai.ts`, `vertex.ts` plus their tests. Registry/factory
wiring in `sdk/packages/llms/src/index.ts`, `providers/ai-sdk.ts`, and `providers/
builtins.ts` that referenced the dropped vendors is being fixed against real build
errors, not guessed — do not assume it's already clean.

## Model catalog (verified 2026-09-20)
Full machine-readable table: **`research/pliny-models.json`**.
Swept all 102 catalog entries plus the ids found in the Kilo config.

- **47 models return working tool calls** (22 self-hosted, 17 hosted, plus pools)
- 13 respond but never emit a tool call -> unusable for an agent
- 19 unavailable (503 no-healthy-upstream, or 400 "auto tool choice requires --enable")

Best self-hosted, by measured context:

| Model | Context | Note |
|---|---:|---|
| `snps-provider/GLM-5.2` | 512,000 | largest self-hosted |
| `snps-provider-vmodels/glm-5.2` | 512,000 | load-balanced pool |
| `snps-provider/kimi-k2.6` | 256,000 | |
| `snps-provider/nvidia-nemotron-3-super-120b-a12` | 256,000 | |
| `snps-provider/qwen3.5-397b-fp8` | 220,000 | Kilo's current default |
| `snps-provider/nemotron-3-ultra-550b-a55` | 200,000 | |
| `snps-provider/qwen3-coder-480b-a35b-inst-fp8` | 128,000 | coding-specialised |

Strongest overall (hosted, supports `cache_control`):
`snps-aws-bedrock/global.anthropic.claude-sonnet-5`

**Kilo's hand-entered context limits are wrong** — it declares 262,144 for GLM-5.2
(actually 512,000) and 131,072 for qwen3.5-397b (actually 220,000). Under-declaring wastes context;
over-declaring causes hard request failures. Use the measured values.

## Prior art: Pliny already works in Kilo Code
`D:\dev0\GPUSurfer\.kilo\kilo.jsonc` (project) + `~/.config/kilo/kilo.jsonc` (global)
already run Pliny in production via **`@ai-sdk/openai-compatible`**. This is the single
strongest evidence for the fork-Cline plan: a generic OpenAI-compatible adapter is enough.

What to port:
- **Provider grouping by pool** — `pliny` (self-hosted), `pliny-internal-tests`,
  `pliny-vmodels`, `pliny-paid` (multi-cloud). Same baseURL, different model sets.
  Worth keeping: it makes the free/paid split obvious in the picker, which matters
  under the $200/month cap.
- **Timeouts** — `timeout: 300000`, `headerTimeout: 120000`, `chunkTimeout: 120000`.
  Self-hosted models are slow to first token; default HTTP timeouts will cut them off.
- **Per-model `X-TFY-*` headers** — carried on every request.
- **`tool_call` / `attachment` flags per model** — the shape of the capability table.

What NOT to port:
- The hand-entered `limit.context` values (measurably wrong — see above).
- The API key lives in the *global* config, in plaintext. For PlinyCode, read
  `PLINY_API_KEY` from env / VS Code SecretStorage instead of writing it to disk.
- Kilo exposes only 12 models; 47 work.

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
