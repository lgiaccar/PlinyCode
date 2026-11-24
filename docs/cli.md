# PlinyCode CLI

The CLI is an executable frontend to the existing Pliny engine. It offers a
minimal terminal conversation and a command that Python scripts and YAML
pipelines can invoke. It does **not** parse YAML jobs or run an HTTP service.

## Build and installation

For ready-to-run Windows ZIP and Linux tar.gz downloads, follow the
[download and installation guide](cli-install.md). The archives include the runtime,
installation instructions and checksums. No build tools are required for users.
The commands below are for building from source.

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
workflow artifacts. CLI tags (`cli-v<version>`) run the same tests and publish
versioned archives in GitHub Releases, independently of the extension auto-updater.

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

## Skills, custom agents and delegation

CLI 0.2.0 uses the same Markdown loaders and agent engine as the extension.
Discovery defaults to the workspace (`--cwd`, or the current folder when omitted).
It does not import editor settings or scan your global editor configuration.

Skills are discovered under `.clinerules/skills`, `.cline/skills`, `.agents/skills`,
`.github/skills`, `.cursor/skills`, `.claude/skills` and `.ai/skills`.
Custom agents are discovered under `.cline/agents`, `.github/agents`,
`.cursor/agents`, `.claude/agents` and `.ai/agents`, including one level of
subfolders. `AGENTS.md` remains workspace guidance, not a custom agent definition.

Inspect discovery without an API key or model request:

```sh
plinycode skills --cwd ./project
plinycode agents --cwd ./project --json
plinycode skills --skills-dir ./shared-skills --json
plinycode agents --agents-dir ./shared-agents
```

`--skills-dir` and `--agents-dir` point directly at directories containing skill
folders/files or agent files. Each flag is repeatable; providing it replaces the
default search locations for that kind. Relative paths resolve against `--cwd`.
An explicitly supplied missing folder is an error. Listings show source paths,
descriptions, disabled skills, skill warnings and agent parsing errors (`--json`
returns `directories`, `items` and `errors`). Invalid agent files are reported and
skipped; an unsupported provider/model in a parsed agent prevents execution.
The engine's collision rules apply: the first agent name wins, while skills use
the engine's file-priority and duplicate-resolution rules. Inspect the listed
source paths to see which definition won. Restart the CLI after changing agents.

Create `.github/skills/review/SKILL.md`:

```markdown
---
name: review
description: Review CI failures and cite evidence from logs
---
Identify each failure, cite the relevant log lines, and distinguish evidence
from assumptions. Return a short Markdown report.
```

Skill folders can include scripts and reference files. Flat `.md`/`.mdc` skills
are also supported, matching the engine. Loading a skill reads its instructions;
it does not automatically run scripts, install dependencies or grant permission.
The agent sees available skill descriptions and can load instructions through
the `skills` tool. Ask it to use a skill by name. `disabled: true` in skill
frontmatter disables it. Hooks and executable plugins remain disabled.

Create `.github/agents/reviewer.md`:

```markdown
---
name: reviewer
description: Review test failures without editing files
tools: [read_files, search_codebase, skills]
skills: [review]
---
Use the review skill. Examine the supplied evidence and report findings.
```

Agent files use YAML frontmatter plus a Markdown prompt body. `.md`, `.yml` and
`.yaml` files are supported; omitted names come from the filename (including
the `.agent.md` convention). Optional `tools` and `skills` restrict the agent's
tools and skill access. Engine tool-name aliases such as `read_file` and `bash`
are recognized. Omitting `tools` leaves the engine's available tools enabled.
Optional `providerId`, `modelId` and `maxIterations` use the engine format; the
CLI accepts only Pliny models. Model overrides in an agent file are explicit
selections, but a run started with FreeAuto rejects paid or unknown overrides.

The portable package includes the examples above under `examples/skills` and
`examples/agents`. From the package directory, try
`plinycode chat --skills-dir examples/skills --agents-dir examples/agents --agent reviewer`.

```sh
plinycode chat --cwd ./project --agent reviewer
plinycode run --cwd ./project --prompt "Delegate the log review to reviewer" --allow-tools --json
plinycode chat --skills-dir ./shared-skills --agents-dir ./shared-agents
```

`--agent` chooses a discovered agent as the lead and applies its instructions,
tool/skill restrictions and model override. Otherwise the normal lead can call
named `subagent_<name>` tools or `spawn_agent` for a generic subtask. Children
have separate model contexts, share the workspace, inherit tool approvals and
return their reports to the lead. The engine defaults generic delegation to
three concurrent children per parent and one level; children cannot delegate
again. These are not isolated worktrees or OS sandboxes.

Interactive delegation asks for approval, and child actions follow the same
approval policy. Concurrent approval questions are presented one at a time.
Unattended delegation requires `--allow-tools`, which authorizes all enabled
tools for the run. Cancellation and the turn timeout cover delegated work too.
Only the lead's answer is streamed/exported as conversation text; child reports
reach the lead through tool results. Output-schema repair cannot delegate or use
skills because its tools are disabled.

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
