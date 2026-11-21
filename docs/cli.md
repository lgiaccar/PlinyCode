# PlinyCode CLI

The CLI is an executable frontend to the existing Pliny engine. It offers a
minimal terminal conversation and a command that Python scripts and YAML
pipelines can invoke. It does **not** parse YAML jobs or run an HTTP service.

## Build and installation

From the repository root, using the Bun version in `.tool-versions`:

```sh
bun install --frozen-lockfile
bun run build:sdk
bun -F @plinycode/cli package
```

Packaging runs on the target platform, Windows x64 or Linux x64. The output
directory is `apps/cli/dist/plinycode-windows-x64` or
`apps/cli/dist/plinycode-linux-x64`. Copy the **whole directory**, including
`runtime/`, then put it on PATH. Windows uses `plinycode.cmd`; Linux uses
`plinycode`. Both launch the included Bun runtime; Node/Bun need not be installed.
`SHA256SUMS` records the packaged files. CI builds both platform packages as
workflow artifacts; this does not publish an official release.

`plinycode doctor` reports the runtime and optional dependencies without making
a gateway request. Git, ripgrep, Python and external stdio MCP server programs
are job dependencies, not installed by the CLI. File search can use the engine's
fallback when ripgrep is absent. The launchers use the system CA store;
`NODE_EXTRA_CA_CERTS` can supply additional PEM certificates. Standard proxy
environment variables are handled by the bundled runtime.

## Credentials and models

Use `PLINY_API_KEY` for CI secret injection. It takes precedence over stored
credentials. `plinycode auth login` reads a hidden key in a terminal;
`plinycode auth login --stdin` accepts secret input from a pipe. Never put a key
in command arguments or a committed pipeline file.

Windows stores a DPAPI-encrypted credential for the current Windows user under
`%LOCALAPPDATA%/PlinyCode/cli/credential.dpapi`. Linux uses Secret Service through
`secret-tool`; a headless host without a keyring should use secret injection.
`plinycode auth logout` deletes the stored credential, not environment variables.
No editor credentials are imported.

```sh
plinycode models
plinycode chat --export transcript.md
```

`models` lists the bundled Pliny chat-model catalog, not a live availability
probe. Omitting `--model` selects **FreeAuto** (`pliny/auto-free`), including for
chat, pipeline runs, and schema-repair calls. A schema-repair call tries a
different free model from the one that produced invalid output, with tools
disabled and the existing single-repair limit. Use `--model <id>` to select a
concrete model instead. Selecting a paid model explicitly can incur charges.

FreeAuto shares its built-in model order, context filtering, reasoning controls,
stream guards and failover implementation with the extension. It uses free
models only, tries at most three fallback switches per run, and retains a
successful model through that run. Authentication errors and cancellation stop
immediately. After partial output, the CLI reports failure instead of replaying
output or completed tools. Routing notices go to stderr; `--stream` adds
`routing` events, leaving the final JSON result contract unchanged.

This CLI supports the default FreeAuto profile. Smart/Fast profiles, BalanceAuto,
extension router settings/rules import, completion-judge/reviewer passes and
image-description routing remain outside this first integration. Context
compaction keeps the CLI's basic strategy with FreeAuto's built-in input budget.

Chat streams responses, asks simple approval questions and accepts follow-ups
while the process is running. End a line with `\` for multiline input. `/exit`
ends the conversation. Ctrl+C cancels and exits. `--export` writes a Markdown
transcript of user messages and final answers, with known credentials redacted.
Transcripts are not resumable sessions. Model-supplied text is not a guarantee
that it contains no other sensitive data.

## Pipeline invocation

```sh
plinycode run --model snps-provider-vmodels/glm-5.3 \
  --prompt "Analyse the test failures and cite the evidence." \
  --file test-results.log --file metrics.json \
  --output-schema judgement.schema.json --json
```

Input files must be text, totalling at most 8 MiB. `--stdin` explicitly reads
piped input, and can be combined with files and a prompt. All relative paths
resolve against `--cwd`, defaulting to the invocation directory. Logs and metrics
are supplied as data, not instructions. Smaller, focused inputs give models more
room to reason; file-size acceptance does not guarantee context-window fit.

Example GitHub Actions step, after installing the CLI and producing the files:

```yaml
- name: Analyse test results
  if: always()
  shell: bash
  env:
    PLINY_API_KEY: ${{ secrets.PLINY_API_KEY }}
  run: |
    plinycode run --model snps-provider-vmodels/glm-5.3 \
      --prompt "Analyse these test results and explain likely causes." \
      --file test-results.log --file metrics.json \
      --output-schema judgement.schema.json --json > judgement.json
```

Azure DevOps uses the same command in a `bash` or `pwsh` step, with a secret
pipeline variable mapped to `PLINY_API_KEY` through `env`. Analysis runs should
use `condition: always()` when they must inspect failed test steps. Decide
separately whether a negative judgement should fail the pipeline: successful
execution of an analysis can correctly return a judgement of `fail`.

See the [Python example](../apps/cli/examples/analyse.py) and
[result schema](../apps/cli/examples/judgement.schema.json).

## Approvals, tools and clarification

Reading files and searching are automatic. Interactive edits, commands, web
fetches and MCP calls ask for approval. Unattended runs deny those actions and
return `needs_input` unless `--allow-tools` was explicitly supplied. That flag
approves enabled tools for the whole run as the current OS user; it is not a
filesystem or process sandbox. No named permission-policy language is included.

`--behavior balanced` asks when missing information materially affects the
result. `decisive` encourages reasonable stated assumptions; `curious` encourages
clarification. These are instructions to the model, not confidence scores or
permission changes. An unattended clarification returns `needs_input` and exits;
submit a new request with the answer. There is no persistent resume.

The CLI uses temporary, isolated engine storage. It loads workspace rules but
does not load extension settings, memory, automatic hooks, skills or plugins.
Sub-agents and checkpoints are disabled. Engine scratch is removed on normal
shutdown; abrupt process termination can leave temporary scratch directories.

## Structured output and artifacts

`--json` writes exactly one result envelope to stdout; diagnostics use stderr.
`--stream` instead writes JSON-lines text/tool events and a final `result` event.
The two options are mutually exclusive. The envelope has a version, status,
result, usage and artifacts on success; input requests and errors have their
own fields. It never includes raw engine conversation state or credentials.

`--output-schema` accepts local JSON Schema draft-07 or 2020-12. External schema
fetches are not performed. Validation checks JSON structure and values, not the
truth of the analysis. If output is invalid, one separate tool-free model call
attempts repair. A remaining validation error exits nonzero; completed actions
are not replayed for repair.

For a generated report, use `--artifacts-dir reports --allow-tools` and ask the
model to write it. The manifest lists new or modified regular files under that
directory; symlinks are excluded. Markdown works with the standard editor tool.
Other formats depend on available tools or MCP servers. Approved commands may
install dependencies in a job-local environment; no document framework or
dependency installer is built into the CLI.

| Exit | Meaning |
| --- | --- |
| 0 | Successful execution and output validation |
| 1 | Execution or authentication failure |
| 2 | Invalid arguments/input/schema or missing credentials |
| 3 | Clarification or tool approval needed |
| 4 | Model output failed schema validation |
| 124 | Timeout |
| 130 | Cancellation |

`--timeout` limits a turn (default 900 seconds); `--max-iterations` bounds agent
iterations (default 40). These do not impose an OS sandbox or a spending limit.

## MCP servers

Pass `--mcp-config servers.json` explicitly. The engine accepts its existing
flat or nested server configurations, for example:

```json
{
  "mcpServers": {
    "analysis": {
      "type": "stdio",
      "command": "python",
      "args": ["analysis_server.py"]
    },
    "remote": {
      "type": "streamableHttp",
      "url": "https://example.internal/mcp"
    },
    "legacy": {
      "type": "sse",
      "url": "https://example.internal/sse"
    }
  }
}
```

Connecting requires approval because stdio discovery starts a program. Without
`--allow-tools`, unattended execution will not even connect. Each interactive
MCP tool call also needs approval. Server connection failures fail the run rather
than silently omitting required tools. Explicit server `cwd` values resolve
against the config directory; otherwise the server starts in the workspace.
Use server-specific environment or header credentials; keep secret-bearing
configuration outside version control. An interactive MCP OAuth onboarding UI
is not part of this first CLI.

## Validation

```sh
bun -F @plinycode/cli typecheck
bun -F @plinycode/cli test
bun -F @plinycode/cli lint
bun -F @plinycode/cli format
bun -F @plinycode/cli package
bun apps/cli/scripts/verify-package.ts
```

The `cli-test` GitHub workflow builds and tests Windows/Linux x64 packages.
Separate `Portable E2E` jobs download those archives without checking out the
repository or installing dependencies. A Python standard-library harness relocates
the package into a path containing spaces and Unicode, verifies checksums, and
removes installed Bun/Node from the child process's PATH. It exercises pipeline
analysis, the Python example, artifact generation, denied edits/commands/MCP
discovery, schema repair, credential redaction across stream chunks, invalid
inputs, timeouts, gateway rejection, and concurrent independent processes.
Linux also checks multiline chat, conversation history and cancellation in a PTY.
The source suite covers all three MCP transports and Windows credential storage.

To run the portable acceptance tests locally after packaging:

```sh
python apps/cli/tests/e2e.py --package apps/cli/dist/plinycode-linux-x64
# Windows: py apps/cli/tests/e2e.py --package apps/cli/dist/plinycode-windows-x64
```

Tests use local mock gateways and MCP fixtures; they do not use a real Pliny key
or measure live-model judgement quality. A representative real MCP server and a
live analysis run remain release acceptance checks.
