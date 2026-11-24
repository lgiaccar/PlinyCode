# PlinyCode CLI

Read the root AGENTS.md. Use Bun pinned in `.tool-versions`, never npm/yarn/pnpm.
This is the minimal standalone CLI: no YAML job parser, server, extension memory
integration, persistent resume, or extension imports.

- All inference uses Pliny. Omitted --model selects default FreeAuto; explicit concrete models remain supported. FreeAuto must never delegate to paid models.
- Pipeline JSON stdout is a public contract; send diagnostic logs to stderr.
- Default unattended execution must not run edits, shell commands or MCP servers.
  MCP discovery can launch programs and therefore needs approval too.
- Keep engine state isolated from editor/user engine settings. Skills and agents
  use workspace discovery or explicit CLI folders. Do not enable automatic hooks
  or executable plugins. Delegation must inherit permissions and FreeAuto policy.
- Rebuild the SDK before running CLI checks after changing engine code.
- Verify with `bun -F @plinycode/cli typecheck`, `test`, `lint`, and `format`.
  `package` includes the pinned Bun runtime; `scripts/verify-package.ts` tests the
  packaged executable. Tests use local gateway/MCP fixtures, not live credentials.
- Write scratch under the repository's ignored `ai_output/`. Build output is
  ignored under `apps/cli/dist/`. Never commit runtime binaries or credentials.
