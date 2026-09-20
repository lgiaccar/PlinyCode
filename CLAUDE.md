# PlinyCode

A Cursor/VS Code coding-agent extension (Cline-like) using **only** our internal
Pliny model gateway. No legacy providers, no user accounts, no non-VS Code surfaces.

**Requirements:** ask/agent/plan modes · conversation compaction · multi-session ·
conversation history · model picker incl. in-house models.

## Goal emphasis
Support **all** Pliny models, especially **self-hosted** ones (no per-token cost,
no frontier-approval gate, no $200 budget pressure). 22 self-hosted models are verified
tool-call-capable; `snps-provider/GLM-5.2` has the largest measured context at 512k.

## Read this first
**`FINDINGS.md`** holds the preliminary research: gateway capabilities verified live,
the effort estimate, and four non-obvious challenges (Node TLS, Anthropic opt-in prompt
caching worth 10x, `/models` lacking capability+authz data, no `Retry-After` on 429).
Do not re-derive any of it — it was measured, not assumed.

**`research/pliny-models.json`** is the verified model catalog: 47 tool-call-capable
models with *measured* context limits. Build the model picker from this, never from
the gateway's `/models` endpoint (it is incomplete, lacks capability data, and ignores
per-user authz).

## Approach
Fork Cline (https://github.com/cline/cline). Pliny is OpenAI-compatible, so Cline's
OpenAI-compatible provider is ~90% of the integration. Forked and stripped already
(see the `fork:` commit) — the provider layer at fork time was a thin Vercel-AI-SDK
adapter with 12 vendor files under `sdk/packages/llms/src/providers/vendors/`, not 62
standalone providers as originally estimated; only `openai-compatible.ts` and
`anthropic.ts` were kept. See `FINDINGS.md`'s 2026-09-20 correction note for detail.

## Pliny
- Base URL: `https://snps-inference.internal.synopsys.com/api/llm`
- Auth: `Authorization: Bearer $PLINY_API_KEY` (env var; ~1040-char PAT)
- Default model: `snps-aws-bedrock/aws-claude-sonnet-4.6`

## Prior art
Pliny already runs in Kilo Code via `@ai-sdk/openai-compatible`
(`D:\dev0\GPUSurfer\.kilo\kilo.jsonc`). Proof that a generic OpenAI-compatible adapter
suffices. Port its pool grouping and long timeouts; do NOT port its context limits
(wrong) or its plaintext on-disk API key.

## Gotchas that will waste your time
- **Node needs `--use-system-ca`** against this gateway, or TLS fails with
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. In the extension, bundle the CA / set an https agent.
- **Anthropic caching is opt-in.** Without `cache_control` blocks you pay ~10x.
- Never print `PLINY_API_KEY` or paste it into shared output.
- Self-hosted models need **long timeouts** (300s request / 120s header+chunk) or they get cut off.
- Some self-hosted models 503 (`no healthy upstream`) or reject `tool_choice:"auto"`. Handle both.
- Verify probes still pass before trusting any provider change: `research/probes/`.
  Regenerate context limits with `node --use-system-ca research/probes/ctxprobe.js <list.txt>`.
- **Build toolchain:** Bun workspaces monorepo (`bun@1.3.13` pinned, `node >=22`).
  `apps/vscode` needs a protobuf/gRPC codegen step (`buf`) before it compiles, and pulls
  in `better-sqlite3` as a native dependency.
