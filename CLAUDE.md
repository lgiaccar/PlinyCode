# PlinyCode

A Cursor/VS Code coding-agent extension (Cline-like) using **only** our internal
Pliny model gateway. No legacy providers, no user accounts, no non-VS Code surfaces.

**Requirements:** ask/agent/plan modes · conversation compaction · multi-session ·
conversation history · model picker incl. in-house models.

## Read this first
**`FINDINGS.md`** holds the preliminary research: gateway capabilities verified live,
the effort estimate, and four non-obvious challenges (Node TLS, Anthropic opt-in prompt
caching worth 10x, `/models` lacking capability+authz data, no `Retry-After` on 429).
Do not re-derive any of it — it was measured, not assumed.

## Approach
Fork Cline (https://github.com/cline/cline). Pliny is OpenAI-compatible, so Cline's
OpenAI-compatible provider is ~90% of the integration. ~202k of Cline's ~370k LOC is
the 62-provider layer that gets deleted.

## Pliny
- Base URL: `https://snps-inference.internal.synopsys.com/api/llm`
- Auth: `Authorization: Bearer $PLINY_API_KEY` (env var; ~1040-char PAT)
- Default model: `snps-aws-bedrock/aws-claude-sonnet-4.6`

## Gotchas that will waste your time
- **Node needs `--use-system-ca`** against this gateway, or TLS fails with
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. In the extension, bundle the CA / set an https agent.
- **Anthropic caching is opt-in.** Without `cache_control` blocks you pay ~10x.
- Never print `PLINY_API_KEY` or paste it into shared output.
- Verify probes still pass before trusting any provider change: `research/probes/`.
