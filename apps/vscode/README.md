# PlinyCode

Synopsys' AI coding agent for VS Code and Cursor, powered by models through the Pliny gateway.

Ask questions about a codebase, prepare a plan, implement changes, run commands, and follow pull requests and
pipelines from your editor. File edits and commands follow your approval settings.

Model requests go through the Synopsys Pliny gateway. Web search, MCP tools and DevOps integrations connect to
their configured services; extension updates come from GitHub.

## What's new in 0.2.8

- Monitor several Azure DevOps agent pools independently, with running pipeline, run and job details and links.
  Existing single-pool settings migrate automatically.
- See agent OS icons and sampled busy-time utilization over the last 24 hours, with observed coverage.
  Utilization measures job occupancy, not CPU or memory usage.
- Keep the Pliny budget visible during loading and outages, with **Retry**, automatic refresh and clearly
  marked last known balances. Expanded conversation headers scroll to keep conversation controls accessible.
- Use updated FreeAuto routes with GLM-5.3 and GLM-5.3 Flash. Saved selections and router rules for the two
  retiring GLM-5.2 replica IDs resolve to GLM-5.3 as soon as this version is installed.
- Discover custom agents and skills under `.ai/`. Hover over an agent name for its description in a compact header.

[Read the 0.2.8 release notes](https://github.com/lgiaccar/PlinyCode/releases/tag/release_0.2.8).
Per-model tuning from a retiring GLM ID is not copied to GLM-5.3; review its thinking and context settings if needed.

## Features

**0.2.9-test.2 prerelease:** optional agent disk monitoring shows working-disk free
space, colored bars, stale readings and low-space/recovery alerts. Set up the small
collector and shared folder using the instructions in **Pipelines > Agents > Disk space**.
Includes test.1's colored utilization meters. Enable **Install pre-releases** in
**Settings > About** to receive test builds. Stable remains **0.2.8**.

- **Plan, Agent and Ask:** plan an approach, implement it, or ask questions without editing project files.
- **Code and terminal tools:** search and navigate a project, edit files, inspect images, run commands and
  monitor background processes.
- **Model routing:** use FreeAuto or BalanceAuto, tune model order and thinking, and manage conversation budgets.
- **Rules, skills and custom agents:** reuse your repository instructions and choose which customizations to enable.
- **Worktree conversations:** run a task on its own branch and checkout, then apply it back or create a pull request.
- **CI Board and pipelines:** watch GitHub and Azure DevOps CI, investigate failures, start fix conversations,
  requeue pipelines and merge eligible pull requests. Monitor multiple Azure DevOps pools, running jobs, OS types and observed utilization.
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
| `plinycode.devops.enabled` | `true` | Run the built-in DevOps MCP server for pull requests and pipelines |
| `plinycode.devops.registerWithEditor` | `true` | Also offer the DevOps MCP server to Copilot Chat or Cursor's agent |
| `plinycode.spending.conversationLimit` | `5` | Budget in US dollars for each new conversation |
| `plinycode.updates.enabled` | `true` | Install new PlinyCode releases from GitHub automatically |
| `plinycode.updates.prerelease` | `false` | Also install pre-releases for developers and testers |
| `plinycode.updates.url` | GitHub | URL of the update manifest |

See the [repository and feature guides](https://github.com/lgiaccar/PlinyCode#features) for configuration details.

## License

Apache-2.0. PlinyCode is derived from the open-source [Cline](https://github.com/cline/cline) project.
