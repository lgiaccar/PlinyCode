# Handoff: PlinyCode — first working Pliny-only fork

## Status
First roughly working version: Pliny provider wired, no Cline account/onboarding,
ClinePass ads disabled, branded as PlinyCode. Build: `bun run build:sdk` +
`apps/vscode` compile/webview.

## Key facts
- Base URL: `https://snps-inference.internal.synopsys.com/api/llm`
- Auth: `Authorization: Bearer $PLINY_API_KEY` (never print)
- Default model: `snps-aws-bedrock/aws-claude-sonnet-4.6`
- Catalog: `research/pliny-models.json` (copied into SDK package) — never `/models`

## Local tooling
- Refresh PATH if bun missing:  
  `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")`
- Git bash needed for `lint:proto`: add `C:\Program Files\Git\bin` to PATH
- Nested `.kilo` worktrees break biome — ignored via `!!**/.kilo` in `apps/vscode/biome.jsonc`

## Run / install
- Dev: Run & Debug → **Run Extension (local)** → F5
- Smoke: `node --use-system-ca research/probes/smoke.js`
- Packaged: `apps/vscode` → vsce → `cursor --install-extension <vsix>`
