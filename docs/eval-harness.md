# Eval harness

The eval harness runs the agent on a fixed set of tasks and checks the results, so a change to a prompt, a tool or the router can be measured instead of judged from a single live run. Version 0 is small: four seed cases, offline playback in CI, and a record mode for the live gateway. It lives in [sdk/scripts/eval](../sdk/scripts/eval); the case and cassette format is in its [README](../sdk/scripts/eval/README.md).

## Why

Router routes, prompts and tool behaviour have been tuned on one live probe at a time and on anecdotes. Core's `agent-runtime.test.ts` and the extension's `router-integration.test.ts` drive the agent loop with scripted models, which tests the plumbing but says nothing about whether the agent got better. The harness gives every such change the same tasks to run, the same checks on the outcome, and a results file to compare.

## How a case runs

`run.ts` takes each case in turn:

1. It copies the case's fixture (`fixtures/<name>/`) to a fresh temp directory.
2. It starts the VCR on the case's `cassette.json`: playback by default, record with `--record`.
3. It starts a one-shot `ClineCore` session, the same engine entry point the extension uses, with the temp directory as `cwd`, the case's model on the `pliny` provider, the default tools for the case's mode (act, plan or ask), every tool auto-approved (`createToolPoliciesWithPreset("yolo")`), sub-agents, MCP settings tools and checkpoints off, and `maxIterations` from the case. `start()` with a prompt and `interactive: false` runs the prompt to completion and returns the `AgentResult`.
4. It checks the assertions against the temp directory and the result.
5. It writes one JSON line to `ai_output/eval/results-<timestamp>.jsonl` and prints a summary table.

The run exits non-zero when any case fails. Before the first case it points the engine's home and `~/.cline` at a throwaway directory and clears `CLINE_*` variables, so the user's sessions, settings, MCP servers, global rules and skills never reach a case. The system prompt is the engine's default (`getClineDefaultSystemPrompt`) for the case's mode. The extension's additions, such as memory, the environment context and the FreeAuto router, are not part of an eval run yet.

### Results

Each line of the results file has:

| Field | Meaning |
| --- | --- |
| `id`, `passed` | the case and whether it passed |
| `assertions[]` | `{type, passed, detail}` per assertion; `detail` says what was found |
| `iterations`, `toolCalls`, `toolErrors` | loop iterations, tool calls, failed tool calls |
| `usage` | `{input, output, cost}`: tokens and USD from the run's usage (cost is the catalog price, zero for self-hosted models) |
| `wallMs`, `finishReason` | wall-clock time and why the agent stopped (`completed`, `max_iterations`, `error`, `timeout`, ...) |
| `mode`, `model`, `tags`, `cassette` | playback or record, the model, the case's tags, cassette responses used out of the total |
| `error` | why the run did not finish normally, when it did not |

## The VCR and the fetch it patches

The VCR in `@plinycode/shared` ([vcr.ts](../sdk/packages/shared/src/vcr.ts)) records and replays `fetch`. It has three entry points:

- `initVcr(mode)`: the original switch, driven by the `CLINE_VCR_*` variables. The provider VCR test in `@plinycode/llms` uses it.
- `installVcrFromEnv()`: reads `PLINYCODE_VCR` (`record` or `playback`) and `PLINYCODE_VCR_CASSETTE`, `_FILTER`, `_INCLUDE_REQUEST_BODY` and `_SSE_DELAY`, with each `CLINE_VCR_*` name as an alias. It does nothing when no mode is set, patches `globalThis.fetch` otherwise, and returns a handle with the VCR's `fetch`, its `stats()` and `stop()`.
- `startVcr(options)`: the programmatic form, one cassette per call. The harness uses it so each case has its own cassette in one process.

Patching `globalThis.fetch` is not enough for every client. The extension's proxy- and CA-aware fetch (`apps/vscode/src/shared/net.ts`) captures `globalThis.fetch` when the module loads, and `buildSessionConfig` in `apps/vscode/src/sdk/cline-session-factory.ts` passes that fetch to the engine as `providerConfig.fetch`, so inference would bypass a VCR installed later. `createPlinyFetch` in `pliny-fetch.ts` wraps the same captured fetch. The harness therefore passes the VCR fetch explicitly, as `ClineCore.create({ fetch })` and `providerConfig.fetch`, and patches the global fetch as well, so in playback any request that slips past the provider config hits the cassette and fails loudly instead of reaching the network. Recording the extension itself would need the same: hand `installVcrFromEnv()`'s `fetch` to the session factory.

## Running it

```sh
bun run build:sdk                                   # once, and after engine changes
bun sdk/scripts/eval/run.ts                         # every case, offline (same as --offline)
bun sdk/scripts/eval/run.ts --case fix --tag act    # filter by id substring and tag
bun sdk/scripts/eval/run.ts --keep                  # keep the temp workspaces to inspect
bun sdk/scripts/eval/run.ts --list
```

The runner sits in `sdk/scripts` rather than a root `scripts/` folder so that Biome's lint and format (which cover `sdk/`) and the `engine-test` workflow's `sdk/**` path filter include it, and so that `@plinycode/*` imports resolve: under Bun they go through `sdk/tsconfig.json`'s paths to the engine source. `@plinycode/llms` still resolves `@plinycode/shared` to its `dist/`, so the SDK must be built first.

### Recording against the live gateway

```sh
PLINY_API_KEY=... bun --use-system-ca sdk/scripts/eval/run.ts --record --case create-file
```

`--record` runs the selected cases against the Pliny gateway and overwrites each one's `cassette.json` with the responses the gateway streamed (request bodies and headers are not saved). Plain Bun does not trust the gateway's certificate chain; `--use-system-ca` or `NODE_EXTRA_CA_CERTS` fixes that. The cassette is written whether or not the case passed, so check the summary before committing it. Playback matches on the request path, so record with the default `PLINY_BASE_URL` (or one with the same `/api/llm` path).

### CI

The `eval-offline` job in [engine-test.yml](../.github/workflows/engine-test.yml) builds the SDK, typechecks the harness (`bun tsc -p sdk/scripts/eval/tsconfig.json`), runs every case offline and uploads `ai_output/eval/` as the `eval-results` artifact. It runs whenever the workflow does, on changes under `sdk/**`.

## Adding a case

1. Put the starting project in `sdk/scripts/eval/fixtures/<name>/`, or reuse one. Keep it small; it is copied for every run.
2. Write `sdk/scripts/eval/cases/<id>/case.yaml` (see the [format](../sdk/scripts/eval/README.md#caseyaml)). Prefer assertions on the outcome (`command_exit_code` running the project's tests, `file_contains`) over assertions on the path the agent took.
3. Record its cassette: `bun --use-system-ca sdk/scripts/eval/run.ts --record --case <id>`. Without gateway access, script the turns in `seed-cassettes.ts` instead.
4. Run `bun sdk/scripts/eval/run.ts --case <id>` and check that it passes offline. Break an assertion once to see the failure message make sense.

Avoid tools that need binaries CI runners may lack: `search_codebase` and `find_files` need `rg` on `PATH`.

## Limitations

- Playback replays the recorded responses whatever the agent sends, so offline runs check that the engine still executes a known-good trajectory (tool parsing, execution, the plan-mode guard, the final state), not how a model would react to a changed prompt. Measuring a prompt or router change needs `--record` runs against the gateway.
- One run per case: no repeats, so no variance yet.
- Concrete models only. The routers are extension code.
- The seed cassettes are scripted, not recorded. They should be replaced by recordings once someone with gateway access runs `--record`.

## Roadmap

- **Router profiles**: let `model` name a router profile (`pliny/auto-free`, `pliny/auto-free-fast`, ...) by moving or exposing the router's `agentModelFactory` so a headless session can use it, then compare profiles on the same cases.
- **Live nightly**: a scheduled job that runs every case with `--record` against the gateway (into a scratch directory rather than over the committed cassettes), several times per case, and reports pass rate, iterations, tokens and cost per profile over time.
- **More cases** from real conversations, especially the stalls and loops the FreeAuto docs describe, plus extension-side context (memory, rules, environment details).
