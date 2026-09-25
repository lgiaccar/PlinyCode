# devops-mcp

A small [MCP](https://modelcontextprotocol.io) server that lets an AI agent open and update pull
requests and read CI results, for **GitHub** (Actions) and **Azure DevOps** (Repos + Pipelines),
through one set of tools. The backend is chosen from the repository's git remote, so the same
server works in any repo and in any MCP client (PlinyCode, VS Code, Cursor).

This folder is self-contained: it is not part of the Bun workspace and is not touched by the
repo's Biome, lint-staged or CI configuration.

## Tools

| Tool | What it does |
| --- | --- |
| `repo_context` | Provider, repo, current/default branch, push state, open PR for the branch. |
| `pr_create` | Create a PR (draft by default) from a pushed branch with a Markdown description. |
| `pr_get` | Show a PR with its full description. |
| `pr_update` | Change the title/description, or replace only one named section of the description. |
| `pipeline_runs` | Recent GitHub Actions runs / Azure Pipelines builds for a branch or PR. |
| `pipeline_report` | One run as Markdown: jobs, failed steps, error messages, log tails. |
| `pr_checks` | Status checks (GitHub) or branch policies + statuses (Azure DevOps) on a PR. |

Every tool takes an optional `workspace` (absolute path of the repo). Without it the server uses
`DEVOPS_MCP_WORKSPACE`, then its own working directory. PR-scoped tools default to the open PR of
the current branch.

**Named sections.** `pr_update(section="ci", body=...)` writes the content between
`<!-- devops-mcp:ci -->` and `<!-- /devops-mcp:ci -->` (invisible when rendered) and leaves the
rest of the description alone, so an agent can keep a CI summary current in a hand-written PR.

## Install

Needs Python 3.10+ and git. Works on Windows, Linux and macOS.

With [uv](https://docs.astral.sh/uv/) (nothing to install up front; `uv run` creates the env):

```sh
uv run --project /path/to/tools/devops-mcp devops-mcp   # this is also the client command
```

Or with a plain virtual environment:

```sh
cd tools/devops-mcp
python3 -m venv .venv                       # Windows: py -3 -m venv .venv
.venv/bin/pip install -e ".[dev]"            # Windows: .venv\Scripts\pip install -e ".[dev]"
```

The server command is then `.venv/bin/devops-mcp` (Windows: `.venv\Scripts\devops-mcp.exe`).

## Sign-in

Environment variables win; otherwise the server reuses a one-time CLI login, so it never stores
a secret itself.

| | Environment variable | One-time login |
| --- | --- | --- |
| GitHub | `GITHUB_TOKEN` or `GH_TOKEN` | `gh auth login` (GitHub Enterprise: `gh auth login --hostname <host>`) |
| Azure DevOps | `AZURE_DEVOPS_PAT` or `AZURE_DEVOPS_EXT_PAT` | `az login` (headless: `az login --use-device-code`) |

Scopes needed: GitHub `repo` (classic) or, fine-grained, *Pull requests: write*, *Actions: read*,
*Checks: read*, *Commit statuses: read*, *Metadata: read*. Azure DevOps PAT: *Code: read & write*,
*Build: read*.

## Client configuration

Replace `<server>` with the command from **Install**, as an absolute path (for example
`D:/dev0/PlinyCode/tools/devops-mcp/.venv/Scripts/devops-mcp.exe`, or `uv` with the `args` shown
in the uv variant).

**PlinyCode**: *MCP Servers → Configure* (edits `~/.cline/data/settings/cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "devops": { "command": "<server>", "args": [] }
  }
}
```

**Cursor**: `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "devops": {
      "command": "<server>",
      "env": { "DEVOPS_MCP_WORKSPACE": "${workspaceFolder}" }
    }
  }
}
```

**VS Code** (Copilot agent mode): `.vscode/mcp.json`, or *MCP: Open User Configuration*:

```json
{
  "servers": {
    "devops": {
      "type": "stdio",
      "command": "<server>",
      "env": { "DEVOPS_MCP_WORKSPACE": "${workspaceFolder}" }
    }
  }
}
```

uv variant for any client: `"command": "uv", "args": ["run", "--project", "/abs/path/tools/devops-mcp", "devops-mcp"]`.
Use `--project`, not `--directory`: `--directory` also changes the working directory, which the
server uses to find the repository.

Clients that cannot expand `${workspaceFolder}` (PlinyCode's global settings) rely on the agent
passing `workspace`; the server's instructions tell it to.

## Other settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVOPS_MCP_WORKSPACE` | working directory | Repository to act on when a call has no `workspace`. |
| `DEVOPS_MCP_REMOTE` | `origin` | Git remote that identifies the hosted repository. |
| `DEVOPS_MCP_PROVIDER` | from host | `github` or `ado`; needed for GitHub Enterprise Server hosts. |

## Limits

- Azure DevOps rejects PR descriptions over 4000 characters; the tools refuse longer ones with a
  clear message instead of truncating. GitHub allows 65536.
- Azure DevOps Server (on-premises) is not supported, only dev.azure.com / visualstudio.com.
- Draft state is set at creation; `pr_update` does not change it.

## Tests

```sh
.venv/bin/python -m pytest     # Windows: .venv\Scripts\python -m pytest
```

The tests use recorded API responses (`httpx.MockTransport`), so they need no network or login.
