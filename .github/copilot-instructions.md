# Copilot instructions for PlinyCode

The instructions for this repo live in `AGENTS.md` files. Read them before making changes:

- [AGENTS.md](../AGENTS.md) at the repo root: toolchain, layout, build and test commands, CI, naming.
- [apps/vscode/AGENTS.md](../apps/vscode/AGENTS.md) for the VS Code extension.
- [sdk/AGENTS.md](../sdk/AGENTS.md) and [sdk/packages/llms/AGENTS.md](../sdk/packages/llms/AGENTS.md) for the engine packages.

Do not add rules here; update the relevant `AGENTS.md` instead. The essentials, in case you can't open those files:

- Use Bun (`bun install`, `bun run …`), never npm, yarn or pnpm.
- After changing anything under `sdk/`, run `bun run build:sdk` before building or testing the extension.
- Before pushing, run `bun run check` (lint, format, builds and typecheck for every package, including the extension).
- Pull requests target the `stage` branch.
- The product name in anything users see is **PlinyCode**. Internal `cline` identifiers (command IDs, the `cline` proto package, `.clinerules`) are kept on purpose.
