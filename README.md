<p align="center">
  <img src="assets/icons/icon.png" width="80" alt="PlinyCode" />
</p>

<h1 align="center">PlinyCode</h1>

<p align="center">
Synopsys' AI coding agent for VS Code and Cursor — powered by internal models via the Pliny gateway.
</p>

---

## What it is

PlinyCode is a VS Code extension that puts an autonomous coding agent in your editor. It plans, reads your
codebase, edits files, and runs terminal commands — with you approving each step.

It talks **only** to Synopsys internal models through the Pliny gateway at
`https://snps-inference.internal.synopsys.com`. No code or prompt leaves the Synopsys network.

## Features

- **Agentic editing** — creates and edits files across your project, reacting to linter and compiler errors as it works.
- **Plan & Act modes** — have the agent draft an approach for your approval before it changes anything.
- **Terminal execution** — runs commands and reads their output, with per-command approval.
- **Context folders** — automatically scans `.github`, `.vscode`, `.devcontainer` and `.cursor` to generate
  project rules in `.cline/rules/` (opt-in per rule).
- **MCP servers** — extend the agent with Model Context Protocol tools.
- **Editor integrations** — explain/improve code from the context menu, generate Jupyter cells, and write
  git commit messages from your staged diff.
- **Human in the loop** — every file write and command runs only after you approve it.

## Requirements

- VS Code `^1.101.0` (or a compatible Cursor build)
- Network access to the Synopsys Pliny gateway
- Node.js >= 22 and Bun 1.3.13 (for building from source only)

## Install

1. Download `PlinyCode-<version>.vsix` from the newest [GitHub release](https://github.com/lgiaccar/PlinyCode/releases).
2. Install it once: **Extensions → ⋯ → Install from VSIX…** (or `code --install-extension PlinyCode-<version>.vsix`),
   then reload the window. An old PlinyCode 0.1.0 install is removed automatically; reload again when asked.
3. Open the PlinyCode icon in the Activity Bar.

From 0.1.3 on, new releases install themselves: PlinyCode checks GitHub at startup and every 6 hours, then offers
**Reload Now**. Run **PlinyCode: Check for Updates**, or click **Check for Updates** in PlinyCode's
**Settings → About**, to check right away. See [docs/releasing.md](docs/releasing.md)
for details and for how to publish a release.

## Build from source

The toolchain is **Bun** (package manager + task runner). Do not use npm/yarn/pnpm.

```sh
bun install
bun run build:sdk        # build the @plinycode/* engine packages first
bun -F plinycode-dev build  # build the extension
```

The extension consumes the engine packages through their compiled `dist/`, so `build:sdk` must run after any
change under `sdk/packages/`. Running processes do not hot-reload engine changes — rebuild and restart.

### Run the dev host

```sh
code --extensionDevelopmentPath=./apps/vscode <some-folder>
```

### Test

```sh
bun -F plinycode-dev test:unit   # bun-based unit tests, no VS Code host needed
bun run types                 # typecheck all packages
```

## Repository layout

| Path                    | Contents                                                          |
| ----------------------- | ----------------------------------------------------------------- |
| `apps/vscode`           | The VS Code extension (`plinycode-dev`) and its webview UI       |
| `sdk/packages/core`     | Agent engine — tasks, sessions, auth, providers, hooks, runtime   |
| `sdk/packages/shared`   | Shared types and utilities                                        |
| `sdk/packages/llms`     | Model catalog and provider gateway                                |
| `sdk/packages/agents`   | Browser-safe agent runtime loop                                   |
| `sdk/packages/ui`       | Shared webview theme and components                               |

## Configuration

| Setting                             | Default                                          | Description                                    |
| ----------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| `plinycode.contextFolders.enabled`  | `true`                                           | Scan context folders to generate project rules |
| `plinycode.contextFolders.folders`  | `.github`, `.vscode`, `.devcontainer`, `.cursor` | Which folders to scan                          |

## License

Apache-2.0 — see [LICENSE](LICENSE).

PlinyCode is derived from the open-source [Cline](https://github.com/cline/cline) project.
