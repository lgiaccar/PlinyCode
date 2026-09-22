# Contributing to PlinyCode

PlinyCode is Synopsys' internal AI coding agent for VS Code and Cursor. Contributions are welcome from
anyone inside Synopsys. All contributors are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs

Open an issue on the internal repository. Before filing, search existing issues to avoid duplicates, and
include:

- What you expected to happen and what actually happened
- The extension version (see the PlinyCode panel, or `apps/vscode/package.json`)
- Your VS Code or Cursor version and OS
- Relevant output from the **PlinyCode** output channel

> 🔐 **Security issues:** do not open a public issue. Report vulnerabilities through Synopsys' internal
> security process — see [SECURITY.md](SECURITY.md).

## Development setup

The toolchain is **Bun 1.3.13** (package manager + task runner) with **Node >= 22** as the runtime. Do not
use npm, yarn or pnpm.

1. Clone the repository and open it in VS Code.
2. Install [Bun](https://bun.com).
3. Install dependencies:
    ```bash
    bun install
    ```
4. Build the engine packages. The extension resolves `@plinycode/*` through their compiled `dist/`, so this
   must run before the first extension build and after any change under `sdk/packages/`:
    ```bash
    bun run build:sdk
    ```
5. Generate the Protocol Buffer code and build the extension:
    ```bash
    cd apps/vscode
    bun run protos
    bun run build:webview
    node esbuild.mjs
    ```
6. Press `F5` (or **Run → Start Debugging**) to launch a VS Code window with the extension loaded. You may
   need the [esbuild problem matchers](https://marketplace.visualstudio.com/items?itemName=connor4312.esbuild-problem-matchers)
   extension if the build task reports issues.

Running processes do **not** hot-reload engine source changes — rebuild with `bun run build:sdk` and restart.

## Repository layout

| Path                  | Contents                                                        |
| --------------------- | --------------------------------------------------------------- |
| `apps/vscode`         | The VS Code extension (`plinycode-dev`) and its webview UI     |
| `sdk/packages/core`   | Agent engine — tasks, sessions, auth, providers, hooks, runtime |
| `sdk/packages/shared` | Shared types and utilities                                      |
| `sdk/packages/llms`   | Model catalog and provider gateway                              |
| `sdk/packages/agents` | Browser-safe agent runtime loop                                 |
| `sdk/packages/ui`     | Shared webview theme and components                             |

## Checks before you push

```bash
bun run types                  # typecheck every package
bun run lint                   # biome lint
bun run format                 # biome format
bun -F plinycode-dev test:unit    # unit tests, no VS Code host required
```

Heavier suites that drive a real extension host:

```bash
bun -F plinycode-dev test:integration   # @vscode/test-electron
bun -F plinycode-dev test:e2e           # Playwright
```

## Pull requests

1. Branch off `master`.
2. Keep the change focused — one concern per PR.
3. Make sure the checks above pass.
4. In the description, explain what changed and why, and note anything a reviewer should test by hand.

## Naming

The product is **PlinyCode**. Use that name in anything a user can see — UI strings, settings descriptions,
docs and commit messages.

Some internal identifiers still use the `cline` prefix and are intentionally left alone, because renaming
them would break existing installs and the wire protocol:

- the `cline.*` VS Code command IDs and context keys
- the `cline` protobuf package namespace
- the `.clinerules` and `.clineignore` workspace files
- the `Documents/Cline` on-disk paths

New user-facing settings use the `plinycode.*` prefix.
