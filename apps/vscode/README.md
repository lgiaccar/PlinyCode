# PlinyCode

Synopsys' AI coding agent for VS Code and Cursor, powered by models through the Pliny gateway.

Ask questions about a codebase, prepare a plan, implement changes, run commands, and follow pull requests and
pipelines from your editor. File edits and commands follow your approval settings.

Model requests go through the Synopsys Pliny gateway. Web search, MCP tools and DevOps integrations connect to
their configured services; extension updates come from GitHub.

## Available in pre-releases

Interface density offers Comfortable and Compact spacing across chat, CI Board, settings and inspection
panels, with consistent theme-aware controls and keyboard focus. Choose it in Settings > General.

The compact chat header and cleaner composer are available in **0.2.10 test builds**. Enable **Install
pre-releases** in **Settings > About**, then run **PlinyCode: Check for Updates**.

The header keeps the task and workspace visible; **Details** shows usage and limits. **More message options**
groups send behavior and secondary controls. Active side questions and non-default send behavior stay labeled
when the options are closed.

The latest test build also adds CI Board search and status filters, visible merge blockers, and the last
successful CI check time. Reviews and repository protections still apply to **CI ready** entries.

## What's new in 0.2.9

[PlinyCode 0.2.9](https://github.com/lgiaccar/PlinyCode/releases/tag/release_0.2.9) is the latest stable release.

- **Cancel and resume reliably:** cancellation stops the current turn and keeps queued messages editable.
  Use **Resume Task** or send a new message to continue after cleanup. Completed edits are not undone.
- **Chat controls:** adjust `plinycode.chat.fontSize` from 10 to 24 pixels (default 13). Agent command terminals
  stay hidden until opened with **PlinyCode: Show Agent Terminal**. Customization tabs scroll correctly again.
- **Grafana machine metrics:** connect a Grafana server in **Pipelines > Agents > Grafana machine metrics...**.
  Agent rows show compact free-disk readings; **Details** opens CPU/GPU history and hardware information.
  History defaults to 30 days, subject to the data available in your Grafana datasource.
- **Low-disk warnings:** fresh readings below 50 GB turn red and trigger a deduplicated editor notification.
  Visible rows refresh automatically; this is not a background disk watcher.
- **Clearer agent status:** colored utilization meters and red labels for disabled agents make the agent list
  easier to scan. Utilization still measures observed job occupancy, not CPU or memory usage.

See the [release notes](https://github.com/lgiaccar/PlinyCode/releases/tag/release_0.2.9) and
[Grafana setup guide](https://github.com/lgiaccar/PlinyCode/blob/stage/docs/grafana-machine-metrics.md). Grafana is optional and requires your server address and a token with dashboard and query access.
The token is kept in the editor's secret storage; no collector or shared folder is required.

## Features

- **Plan, Agent and Ask:** plan an approach, implement it, or ask questions without editing project files.
- **Code and terminal tools:** search and navigate a project, edit files, inspect images, run commands and
  monitor background processes.
- **Model routing:** use FreeAuto or BalanceAuto, tune model order and thinking, and manage conversation budgets.
- **Rules, skills and custom agents:** reuse your repository instructions and choose which customizations to enable.
- **Worktree conversations:** run a task on its own branch and checkout, then apply it back or create a pull request.
- **CI Board and pipelines:** watch GitHub and Azure DevOps CI, investigate failures, start fix conversations,
  requeue pipelines and merge eligible pull requests. Monitor multiple Azure DevOps pools, running jobs, OS types and observed utilization.
- **Grafana machine metrics:** view free disk space, low-disk warnings and optional CPU/GPU histories for agents.
- **MCP servers:** extend the agent with tools, including the built-in DevOps MCP server.
- **Conversation controls:** ask read-only side questions, improve drafts, expand long prompts, and restart from
  an earlier message with optional file reversion.
- **Memory and diagnostics:** retain repository knowledge, search previous conversations and export diagnostics.
- **Editor integrations:** explain or improve a selection, work with Jupyter cells and generate commit messages.

## Getting started

1. Use VS Code `^1.101.0` or a compatible Cursor build, with access to the Synopsys Pliny gateway.
2. Download the `.vsix` from the [latest stable GitHub release](https://github.com/lgiaccar/PlinyCode/releases/latest).
3. Choose **Extensions > ... > Install from VSIX...**, select the file and reload the window.
4. Open PlinyCode from the Activity Bar.
5. Add a Pliny API key in **Settings > API Configuration > Pliny API Keys**, or set `PLINY_API_KEY` before
   starting the editor. You can keep several named keys and choose which one is active.
6. Select a mode and model, then describe your task.

PlinyCode is distributed through GitHub Releases. It checks for updates at startup and every six hours,
installs newer stable versions, and offers **Reload Now**. Use **PlinyCode: Check for Updates** to check immediately.
Enable **Install pre-releases** in **Settings > About** only if you want test builds too.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `plinycode.chat.fontSize` | `13` | Chat text size in pixels, from 10 to 24 |
| `plinycode.devops.enabled` | `true` | Run the built-in DevOps MCP server for pull requests and pipelines |
| `plinycode.devops.registerWithEditor` | `true` | Also offer the DevOps MCP server to Copilot Chat or Cursor's agent |
| `plinycode.spending.conversationLimit` | `5` | Budget in US dollars for each new conversation |
| `plinycode.updates.enabled` | `true` | Install new PlinyCode releases from GitHub automatically |
| `plinycode.updates.prerelease` | `false` | Also install pre-releases for developers and testers |
| `plinycode.updates.url` | GitHub | URL of the update manifest |

See the [repository and feature guides](https://github.com/lgiaccar/PlinyCode#features) for configuration details.

## License

Apache-2.0. PlinyCode is derived from the open-source [Cline](https://github.com/cline/cline) project.
