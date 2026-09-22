# PlinyCode

Synopsys' AI coding agent for VS Code and Cursor — powered by internal models via the Pliny gateway.

PlinyCode handles complex development tasks step by step. It creates and edits files, explores large
projects, and runs terminal commands after you grant permission. Every file change and command is shown to
you for approval first, so you stay in control of what happens in your workspace.

All requests go **only** to Synopsys internal models through the Pliny gateway
(`https://snps-inference.internal.synopsys.com`). Your code and prompts do not leave the Synopsys network.

## How it works

1. Describe your task — you can add images to turn mockups into working UI or to report a visual bug.
2. PlinyCode analyzes your file structure and source code, runs searches, and reads the relevant files to
   get up to speed on the project without overwhelming the context window.
3. Once it has what it needs, it can:
    - Create and edit files, watching linter and compiler errors and fixing issues like missing imports and
      syntax errors as it goes.
    - Execute terminal commands and monitor their output, reacting to failures as they happen.
    - Ask you to approve each change before it is applied.
4. When the task is done, PlinyCode presents the result along with any command you need to run.

## Features

- **Plan & Act modes** — let the agent propose a plan for your approval before it touches any code.
- **Context folders** — automatically scans `.github`, `.vscode`, `.devcontainer` and `.cursor` to generate
  project rules in `.cline/rules/`, which you enable per rule.
- **MCP servers** — extend the agent with Model Context Protocol tools.
- **Editor integrations** — explain or improve a selection from the context menu, generate and improve
  Jupyter cells, and write git commit messages from your staged diff.
- **Checkpoints** — review and roll back the workspace as a task progresses.

## Getting started

1. Install the extension.
2. Click the PlinyCode icon in the Activity Bar.
3. Make sure you are on the Synopsys network so the gateway is reachable.
4. Enter your first task.

## Settings

| Setting                            | Default                                          | Description                                    |
| ---------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| `plinycode.contextFolders.enabled` | `true`                                           | Scan context folders to generate project rules |
| `plinycode.contextFolders.folders` | `.github`, `.vscode`, `.devcontainer`, `.cursor` | Which folders to scan                          |

## License

Apache-2.0. PlinyCode is derived from the open-source [Cline](https://github.com/cline/cline) project.
