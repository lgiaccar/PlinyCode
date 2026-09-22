This is the **PlinyCode** monorepo. Toolchain is **Bun 1.3.13** (package manager + task runner) with **Node >=22** as the runtime. Do not use npm/yarn/pnpm.

PlinyCode is a VS Code / Cursor extension that talks only to Synopsys internal models through the Pliny gateway (`https://snps-inference.internal.synopsys.com`).

## Layout

| Path                  | Contents                                                        |
| --------------------- | --------------------------------------------------------------- |
| `apps/vscode`         | The VS Code extension (`claude-dev`) and its webview UI         |
| `sdk/packages/core`   | Agent engine — tasks, sessions, auth, providers, hooks, runtime |
| `sdk/packages/shared` | Shared types and utilities                                      |
| `sdk/packages/llms`   | Model catalog and provider gateway                              |
| `sdk/packages/agents` | Browser-safe agent runtime loop                                 |
| `sdk/packages/ui`     | Shared webview theme and components                             |

Despite living under `sdk/`, these packages are **not** a distributable SDK — they are the engine the extension runs on. Over 100 files in `apps/vscode/src` import them.

## Build / lint / test

- Engine packages (`@plinycode/shared|llms|agents|core`) resolve each other through compiled `dist/` (their `exports` point only at `dist/`, with no `development` source condition). You **must** run `bun run build:sdk` after changing engine source before running the extension or its tests, otherwise imports fail with missing `@plinycode/*` / missing `dist/` errors. Running processes do **not** hot-reload engine source changes — rebuild and restart.
- `bun run types` typechecks every package; `bun run lint` and `bun run format` run Biome.
- `bun -F claude-dev test:unit` runs the bun-based extension unit suite (no VS Code host needed). `bun run test` runs the engine + extension suites.
- Some engine tests need `bash`, `bun` and network access on PATH; they fail in environments lacking those, which is an environment artifact rather than a code bug.

## VS Code extension (`apps/vscode`, package `claude-dev`)

- **Codegen prerequisite:** `bun run protos` (from `apps/vscode`) regenerates `src/generated/*` and the webview grpc client. The `dev`, `build:webview`, and `check-types` scripts already run it, so proto changes are picked up by those commands; run it manually only if you edit `.proto` files without a full build. `src/generated/` is gitignored, so a stale local copy can produce type errors that CI does not see.
- **Build:** `bun run build:webview` (webview UI) then `bun esbuild.mjs` (extension bundle). `bun run package` does the full production build.
- **Run it (dev host):** `code --extensionDevelopmentPath=./apps/vscode <some-folder>`, then click the PlinyCode icon in the Activity Bar. On Linux containers add `--no-sandbox`.
- **Test:** `bun run test:unit` (bun-based, no VS Code host). `bun run test:integration` (`@vscode/test-electron`) and `bun run test:e2e` (Playwright) exercise a real extension host and are heavier.

## Naming

The product is **PlinyCode**. Use that name in anything a user can see — UI strings, settings descriptions, docs and commit messages. New user-facing settings use the `plinycode.*` prefix.

Some internal identifiers intentionally keep the `cline` prefix, because renaming them would break existing installs and the wire protocol:

- the `cline.*` VS Code command IDs and context keys
- the `cline` protobuf package namespace (and the `@cline-grpc/*` path alias)
- the `.clinerules` and `.clineignore` workspace files
- the `Documents/Cline` on-disk paths
