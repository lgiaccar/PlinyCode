<p align="center">
  <img src="assets/icons/icon.png" width="80" alt="PlinyCode" />
</p>

<h1 align="center">PlinyCode</h1>

<p align="center">
Synopsys' AI coding agent for VS Code and Cursor, powered by models through the Pliny gateway.
</p>

<p align="center">
  <a href="https://github.com/lgiaccar/PlinyCode/releases/latest">Download the latest release</a> ·
  <a href="docs/releasing.md">Install and update</a> ·
  <a href="REPOMAP.md">Repository guide</a>
</p>

## What it is

PlinyCode brings an AI coding agent into VS Code and Cursor. Ask questions about your codebase, prepare a plan,
implement changes, run commands, and follow pull requests and pipelines from the editor.

Model requests go through the Synopsys Pliny gateway. You need gateway access and a Pliny API key to use it.
Web search, MCP tools and DevOps integrations connect to their configured services; extension updates come from GitHub.

## What's new in 0.2.8

[PlinyCode 0.2.8](https://github.com/lgiaccar/PlinyCode/releases/tag/release_0.2.8) is the latest stable release.

- **Multiple agent pools:** monitor several Azure DevOps pools independently in **Pipelines > Agents**. Busy
  agents show their pipeline, run and job details with links, and existing single-pool settings migrate automatically.
- **Agent OS and utilization:** see Windows, Linux or macOS icons and sampled busy-time utilization over the
  last 24 hours, alongside observed coverage. This measures job occupancy, not CPU or memory usage.
- **Budget visibility and recovery:** the Pliny budget row stays visible while loading or during service outages,
  with **Retry**, automatic refresh and clearly marked last known balances. Expanded conversation headers scroll
  so the prompt and conversation controls remain accessible.
- **Updated model routing:** FreeAuto routes include GLM-5.3 and GLM-5.3 Flash. Saved selections and router rules
  for the two retiring GLM-5.2 replica IDs resolve to GLM-5.3. The migration takes effect when this version is installed.
- **Custom-agent improvements:** discover agents and skills under `.ai/`, and hover over an agent name to see
  its description without expanding the chat header.

See the [release notes](https://github.com/lgiaccar/PlinyCode/releases/tag/release_0.2.8) and
[model migration details](docs/model-update-2026-11-06.md). Existing per-model tuning for a retired ID is not
copied to GLM-5.3; review its thinking and context settings if you customized the old model.

## Features

The **0.2.9-test.2 prerelease** adds optional [agent disk monitoring](docs/agent-disk-monitor.md):
a small collector reports working-disk free space through a shared folder, with
colored bars, stale-reading indicators and optional low-space/recovery alerts.
It also includes the colored agent-utilization meters from test.1.
Enable **Install pre-releases** in **Settings > About** to receive test builds.

- **Plan, Agent and Ask modes:** prepare a plan, let the agent implement it, or ask questions without editing
  project files. [Plan mode](docs/plan-mode.md) · [Ask mode](docs/ask-mode.md)
- **Code and terminal tools:** search and navigate code, edit files, inspect images, run commands, and monitor
  background processes. File edits and commands follow your approval settings. [Agent tools](docs/agent-tools.md)
- **Model routing and tuning:** use FreeAuto or BalanceAuto to route tasks through Pliny models, choose model
  order, and adjust thinking and context settings. [Router settings](docs/router-settings.md) · [Model tuning](docs/model-tuning.md)
- **Rules, skills and custom agents:** reuse repository instructions, choose task-specific agents, and control
  which rules, skills, agents and hooks are enabled, including agents and skills discovered under `.ai/`. [Rules and customization](docs/rules.md)
- **Worktree conversations:** start work on a separate branch and checkout, then apply it back or create a pull
  request. [Run in worktree](docs/task-worktrees.md)
- **GitHub and Azure DevOps:** review pull requests, launch pipelines, watch CI and investigate failures from
  the editor. The CI Board can start fix conversations, requeue pipelines and merge eligible pull requests.
  Monitor multiple agent pools, running jobs, OS types and observed busy-time utilization.
  [CI Board](docs/ci-board.md) · [Pipelines](docs/pipeline-runs.md) · [Agent monitor](docs/agent-monitor.md)
- **MCP integrations:** connect external tools or use the built-in DevOps MCP server from PlinyCode and
  compatible editor agents. [DevOps MCP](docs/devops-mcp.md)
- **Conversation tools:** ask side questions, improve a draft prompt, expand long pasted text, and edit an
  earlier message to restart from it, optionally reverting files. [Side questions](docs/side-questions.md) ·
  [Improve prompt](docs/improve-prompt.md) · [Restart from here](docs/restart-from-here.md)
- **Memory and diagnostics:** retain repository knowledge, search past conversations, inspect request traces
  and export a diagnostics bundle. [Memory](docs/memory.md) · [Diagnostics](docs/diagnostics-bundle.md)

## Install

PlinyCode is distributed through **GitHub Releases**, rather than the VS Code Marketplace or Open VSX.

1. Download the `.vsix` from the [latest stable release](https://github.com/lgiaccar/PlinyCode/releases/latest).
2. In VS Code or Cursor, choose **Extensions > ... > Install from VSIX...**, select the file and reload the window.
3. Open PlinyCode from the Activity Bar.
4. Add your Pliny API key under **Settings > API Configuration > Pliny API Keys**. You can keep several named
   keys and select the active one. Alternatively, set `PLINY_API_KEY` before starting the editor.
   See [API key setup](docs/pliny-api-keys.md).

PlinyCode checks for updates at startup and every six hours, installs newer stable releases, and offers
**Reload Now**. Use **PlinyCode: Check for Updates** or **Settings > About > Check for Updates** to check immediately.
Testers can enable **Install pre-releases** in **Settings > About** to receive `-test.N` builds too.
See [installing, updating and releasing](docs/releasing.md).

## Requirements

- VS Code `^1.101.0` or a compatible Cursor build.
- Network access to the Synopsys Pliny gateway and a Pliny API key.
- Git for checkpoints and worktree features.
- For building from source: Bun **1.3.14** and Node.js **>=22**, with the toolchain pinned in `.tool-versions`.

## Build from source

Use **Bun** as the package manager and task runner; do not use npm, yarn or pnpm.

```sh
bun install --frozen-lockfile
bun run build:sdk
bun -F plinycode-dev build
```

The extension imports the engine packages from their compiled `dist/` directories. Rebuild after changing
`sdk/packages/`, then restart the extension host. `bun run watch:sdk` rebuilds changed engine packages while you work.

Start a development host:

```sh
code --extensionDevelopmentPath=./apps/vscode <some-folder>
```

Run the main checks:

```sh
bun run types
bun -F plinycode-dev test:unit
bun run check:docs
```

See [AGENTS.md](AGENTS.md) and the [extension guide](apps/vscode/AGENTS.md) for the full build and test workflow.

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/vscode` | VS Code / Cursor extension and its webview UI |
| `sdk/packages/core` | Agent engine: tasks, sessions, providers, hooks and runtime |
| `sdk/packages/shared` | Shared types and utilities |
| `sdk/packages/llms` | Model catalog and provider gateway |
| `docs` | Feature guides, configuration and release procedures |

The packages under `sdk/` are the extension's engine, not a separately distributed SDK.
See [REPOMAP.md](REPOMAP.md) for a detailed directory guide.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `plinycode.devops.enabled` | `true` | Run the built-in DevOps MCP server for pull requests and pipelines |
| `plinycode.devops.registerWithEditor` | `true` | Also offer the DevOps MCP server to Copilot Chat or Cursor's agent |
| `plinycode.spending.conversationLimit` | `5` | Budget in US dollars for each new conversation |
| `plinycode.updates.enabled` | `true` | Install new PlinyCode releases from GitHub automatically |
| `plinycode.updates.prerelease` | `false` | Also install pre-releases for developers and testers |
| `plinycode.updates.url` | GitHub | URL of the update manifest |

## License

Apache-2.0 — see [LICENSE](LICENSE).

PlinyCode is derived from the open-source [Cline](https://github.com/cline/cline) project.
