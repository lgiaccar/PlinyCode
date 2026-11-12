# PlinyCode

Synopsys' AI coding agent for VS Code and Cursor, powered by models through the Pliny gateway.

Ask questions about a codebase, prepare a plan, implement changes, run commands, and follow pull requests and
pipelines from your editor. File edits and commands follow your approval settings.

Model requests go through the Synopsys Pliny gateway. Web search, MCP tools and DevOps integrations connect to
their configured services; extension updates come from GitHub.

## What's new in 0.2.10

[PlinyCode 0.2.10](https://github.com/lgiaccar/PlinyCode/releases/tag/release_0.2.10) is the latest stable release.

- **Clearer chat controls:** the compact header keeps the task and workspace visible, with usage and limits under
  **Details**. **Improve prompt** and **Side question** sit on the right below the prompt box; secondary controls
  are in **More message options**. [Chat controls](https://github.com/lgiaccar/PlinyCode/blob/stage/docs/chat-controls.md)
- **Comfortable or Compact spacing:** choose **Settings > General > Interface density** to adjust spacing across
  chat, CI Board, settings and inspection panels without changing text size. [Interface density](https://github.com/lgiaccar/PlinyCode/blob/stage/docs/interface-density.md)
- **Searchable settings:** find settings by name or description, filter modified values, see their effective source,
  and edit or reset individual User, Workspace or Folder overrides. [Settings search](https://github.com/lgiaccar/PlinyCode/blob/stage/docs/settings-search.md)
- **Captured context inspector:** open **Context** in the task header to search recent captured model requests and
  inspect source text and estimated token usage. Preview limits are explicit; captures are retained only until
  the extension restarts. [Context inspector](https://github.com/lgiaccar/PlinyCode/blob/stage/docs/context-inspector.md)
- **Delivery evidence:** completed Agent responses show recorded tool results and branch PR/check status, with
  a follow-up action to verify delivery. Missing evidence stays **Not confirmed**. [Delivery card](https://github.com/lgiaccar/PlinyCode/blob/stage/docs/delivery-card.md)
- **Needs-attention inbox:** find approvals, questions, failed runs and completed conversations to review, alongside
  watched CI issues. Review acknowledgements reset with new activity. [Attention inbox](https://github.com/lgiaccar/PlinyCode/blob/stage/docs/attention-inbox.md)
- **CI Board search and filters:** find watched items, filter by status, and see merge blockers and the last
  successful CI check time. **CI ready** still respects repository protections and reviews. [CI Board](https://github.com/lgiaccar/PlinyCode/blob/stage/docs/ci-board.md)
- **Copy monitoring details:** select and copy agent names and monitoring values from the Agents panel.

See the [0.2.10 release notes](https://github.com/lgiaccar/PlinyCode/releases/tag/release_0.2.10).

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
- **Inspection and review:** inspect captured context and delivery evidence, and use the attention inbox to find
  conversations and watched CI needing action.
- **Search and layout:** search editor settings, reset scoped overrides, and choose Comfortable or Compact spacing.
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
| `plinycode.ui.density` | `comfortable` | Interface spacing: `comfortable` or `compact` |
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
