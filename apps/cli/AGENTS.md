# PlinyCode CLI

Read the root AGENTS.md. Use Bun pinned in `.tool-versions`, never npm/yarn/pnpm.
This is the minimal standalone CLI: no YAML job parser, server, routers, memory
integration, persistent resume, or extension imports.

- All inference uses the Pliny provider and an explicitly selected concrete model.
- Pipeline JSON stdout is a public contract; send diagnostic logs to stderr.
- Default unattended execution must not run edits, shell commands or MCP servers.
  MCP discovery can launch programs and therefore needs approval too.
- Keep engine state isolated from editor/user engine settings. Do not enable
  automatic hooks/plugins or sub-agents as a side effect of adding a feature.
- Rebuild the SDK before running CLI checks after changing engine code.
- Verify with `bun -F @plinycode/cli typecheck`, `test`, `lint`, and `format`.
  `package` includes the pinned Bun runtime; `scripts/verify-package.ts` tests the
  packaged executable. Tests use local gateway/MCP fixtures, not live credentials.
- Write scratch under the repository's ignored `ai_output/`. Build output is
  ignored under `apps/cli/dist/`. Never commit runtime binaries or credentials.
