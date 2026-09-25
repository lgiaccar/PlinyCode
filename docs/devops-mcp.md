# PlinyCode DevOps (built-in MCP server)

PlinyCode ships an MCP server that lets an agent **create and update pull requests** and **read CI pipeline
results**, on **GitHub** (Actions) and **Azure DevOps** (Repos + Pipelines). It comes with the extension:
users need no Python, Node, repository checkout or configuration file.

The same server is available to:

- **PlinyCode's agent**, automatically.
- **Copilot Chat** (agent mode) in VS Code, and **Cursor's agent**. PlinyCode registers the server with the
  editor when it starts.
- **Any other MCP client**, through a config copied from the PlinyCode GUI.

## Tools

| Tool              | What it does                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `repo_context`    | Provider, repository, current and default branch, push state, open PR for the branch.         |
| `pr_create`       | Creates a PR (draft by default) from a pushed branch, with a Markdown description.            |
| `pr_get`          | Shows a PR with its full description.                                                         |
| `pr_update`       | Changes the title or description, or only one named section of the description.              |
| `pipeline_runs`   | Recent GitHub Actions runs or Azure Pipelines builds, for a branch or a PR.                   |
| `pipeline_report` | One run: job results, failed steps, error messages and the log lines around the failure.     |
| `pr_checks`       | GitHub check runs and statuses, or Azure DevOps branch policies and PR statuses.             |

The repository comes from the workspace's git remote (`origin`). Every tool also takes a `workspace` argument
with the repository's absolute path.

`pr_update(section="ci", body=…)` rewrites only the text between `<!-- devops-mcp:ci -->` and
`<!-- /devops-mcp:ci -->`, which don't render, so an agent can keep a generated section current without
touching the hand-written part of the description.

Azure DevOps limits PR descriptions to 4000 characters (GitHub: 65536). Longer ones are refused with a message
telling the agent to shorten them; they are never truncated silently.

## In the PlinyCode GUI

The server is listed first wherever PlinyCode lists MCP servers: the server icon in the chat input, and
**MCP Servers** (the server icon at the top of the PlinyCode panel) → **Configure**. The row shows whether it's
running and how many tools it has, with a ▶ button that runs a read-only test task in PlinyCode (repository,
branch and latest CI runs), a restart button and an on/off switch. In the Configure view, click the row for
its tools, sign-in details, the steps to use it from the editor's own chat, and **Copy prompt** for that chat.

## Using it from Copilot Chat or Cursor

**VS Code (Copilot Chat).** PlinyCode registers the server as **PlinyCode DevOps**. In the Chat view, switch to
**Agent** mode, click **Configure Tools** and tick **PlinyCode DevOps**. VS Code may ask you to trust the server
the first time. **MCP: List Servers** in the Command Palette starts, stops or shows its output.

**Cursor.** PlinyCode registers the server as `plinycode-devops` through Cursor's extension API. To see it,
open **Cursor Settings** (gear icon at the top right, or Ctrl+Shift+J) → **Customize** → **MCPs**; Cursor
versions before 3.x call the page **Tools & MCP**. Check that it's switched on, then ask the agent in Agent
mode (Ctrl+L).

**Other clients.** In the card, **Copy MCP config** copies an `mcpServers` entry. It runs the editor's own
executable in Node mode (`ELECTRON_RUN_AS_NODE=1`) with a copy of the server kept in the extension's global
storage, so the path survives extension updates.

To keep the server out of the editor's chat, turn off `plinycode.devops.registerWithEditor`.

## Sign-in

The server tries, in order:

1. `GITHUB_TOKEN` / `GH_TOKEN`, or `AZURE_DEVOPS_PAT` / `AZURE_DEVOPS_EXT_PAT`.
2. The editor's existing GitHub or Microsoft sign-in.
3. An existing `gh auth login` or `az login`.
4. The editor's sign-in prompt: the first time a tool needs GitHub or Azure DevOps, the editor asks you to sign
   in with your GitHub or Microsoft work account.

Steps 2 and 4 go through PlinyCode, so they work for PlinyCode's agent and for the editor's chat, but not for
configs copied to other clients, which use steps 1 and 3.

GitHub Enterprise Server hosts use the editor's `github-enterprise` sign-in, and need
`DEVOPS_MCP_PROVIDER=github` because the host name alone doesn't identify the API. Azure DevOps Server
(on-premises) is not supported.

## Settings

| Setting                                | Default | Meaning                                                           |
| -------------------------------------- | ------- | ----------------------------------------------------------------- |
| `plinycode.devops.enabled`             | `true`  | Run the server.                                                   |
| `plinycode.devops.registerWithEditor`  | `true`  | Offer it to Copilot Chat (VS Code) or Cursor's agent.             |

Environment variables read by the server: `DEVOPS_MCP_WORKSPACE` (repository when a call has none),
`DEVOPS_MCP_REMOTE` (default `origin`) and `DEVOPS_MCP_PROVIDER` (`github` or `ado`).

## Troubleshooting

- **The card says Error.** Use the restart button. The server's own messages are in **Output → PlinyCode**,
  prefixed `[DevOpsMcp]`.
- **"No credentials available".** Sign in when the editor asks, or run `gh auth login` / `az login` once.
- **"is not inside a git repository".** The agent passed no `workspace` and the window's first folder isn't a
  git checkout; ask it to pass the repository path.

## For developers

The code is in `apps/vscode/src/services/devops-mcp/`:

| Path                       | Contents                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `server/`                  | The MCP server. No `vscode` import; bundled by `esbuild.mjs` into `dist/devops-mcp.js`.     |
| `server/providers/`        | GitHub and Azure DevOps REST clients behind one `Provider` interface.                       |
| `host/DevOpsMcpService.ts` | Starts the server, tracks its status, feeds its tools to the agent, registers it with the editor. |
| `host/token-broker.ts`     | Local pipe that hands the editor's sign-in tokens to the server process.                   |
| `builtin-mcp-registry.ts`  | How the agent session and the GUI handlers reach the service without importing `vscode`.   |

The built-in server is deliberately not in McpHub, which only manages servers from the user's MCP settings
file. Tests: `bun test src/services/devops-mcp` (from `apps/vscode`), which needs `git` on `PATH` but no
network or login.
