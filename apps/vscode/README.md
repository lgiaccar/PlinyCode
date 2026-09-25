# PlinyCode extension (`plinycode-dev`)

The PlinyCode VS Code / Cursor extension. It talks only to Synopsys internal models, through the Pliny gateway.

This README is for people working on the code. Packaged builds replace it with [README.marketplace.md](README.marketplace.md), which is what users see in the editor (`scripts/release.ts` swaps it in when packaging).

- **Developing:** start with [AGENTS.md](AGENTS.md) for how the extension is put together and how to test it. The root [AGENTS.md](../../AGENTS.md) covers toolchain and repo layout.
- **Releasing:** [docs/releasing.md](../../docs/releasing.md).

## Quick start

From the repo root:

```sh
bun install
bun run build:sdk
```

Then, from `apps/vscode`:

```sh
bun run build:webview
bun esbuild.mjs
code --extensionDevelopmentPath=. <some-folder>
```

Click the PlinyCode icon in the Activity Bar.
