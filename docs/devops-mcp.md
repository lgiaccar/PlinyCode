# PlinyCode DevOps (built-in MCP server)

PlinyCode ships an MCP server that lets an agent **create and update pull requests** and **read CI pipeline
results**, on **GitHub** (Actions) and **Azure DevOps** (Repos + Pipelines). It comes with the extension:
users need no Python, Node, repository checkout or configuration file.

The same server is available to:

- **PlinyCode's agent**, automatically, in a session whose folder is a git repository with a GitHub or Azure
  DevOps remote. Elsewhere its tools are left out, since their schemas would be sent with every request for
  nothing.
- **Copilot Chat** (agent mode) in VS Code, and **Cursor's agent**. PlinyCode registers the server with the
  editor when it starts.
- **Any other MCP client**, through a config copied from the PlinyCode GUI.

## Tools

| Tool              | What it does                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `repo_context`    | Provider, repository, current and default branch, push state, open PR for the branch.         |
| `pr_create`       | Creates a PR (draft by default) from a pushed branch, with a Markdown description.            |
| `pr_get`          | Shows a PR with its full description.                                                         |
| `pr_update`       | Changes the title, the description (or one named section of it), or the draft status.       |
| `pipeline_runs`   | Recent GitHub Actions runs or Azure Pipelines builds, for a branch or a PR.                   |
| `pipeline_report` | One run: job results, failed steps, error messages and the log lines around the failure.     |
| `pr_checks`       | GitHub check runs and statuses, or Azure DevOps branch policies and PR statuses.             |

The repository comes from the workspace's git remote (`origin`). Every tool also takes a `workspace` argument
with the repository's absolute path.

`pr_update(section="ci", body=…)` rewrites only the text between `<!-- devops-mcp:ci -->` and
`<!-- /devops-mcp:ci -->`, which don't render, so an agent can keep a generated section current without
touching the hand-written part of the description.

`pr_update(draft=false)` publishes a draft PR (marks it ready for review), and `draft=true` turns it back into a
draft. Azure DevOps takes this as an `isDraft` update. GitHub's REST API can't change the draft status, so on
GitHub the server calls the GraphQL `markPullRequestReadyForReview` or `convertPullRequestToDraft` mutation,
which uses the same token.

Azure DevOps limits PR descriptions to 4000 characters (GitHub: 65536). Longer ones are refused with a message
telling the agent to shorten them; they are never truncated silently.

## Watching CI (`watch_ci`)

After the agent pushes a change, it can call `watch_ci` instead of polling `pipeline_runs` or calling `wait`.
The tool returns at once and the agent ends its turn. PlinyCode then checks CI in the background, without the
model, and sends the result into the conversation as a new message when the runs end. That message starts a
turn, so the agent can look at a failure and fix it.

`watch_ci` is a PlinyCode tool, not one of the server's: Copilot Chat and Cursor have no way to receive a result
later, so the server's own instructions don't mention it. PlinyCode offers it wherever it offers the DevOps
tools, while `plinycode.ci.watch` is on.

| Argument | Meaning                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------- |
| `pr`     | Pull request to watch. Default: the open PR of `branch`.                                            |
| `branch` | Branch to watch: its open PR, or its pushed head commit when it has none. Default: the current branch. |
| `until`  | `finished` (default) waits for every run; `first_failure` reports as soon as one run fails.          |
| `cancel` | `true` stops the conversation's watch.                                                               |

How a watch runs:

- It watches the head commit it saw when it started. If the PR or branch moves to a new commit (another push),
  it follows the new one and the report says so. A bare branch's head is read from the remote-tracking ref, so a
  push from this checkout moves it; a pull request's head comes from GitHub or Azure DevOps.
- It checks every 30 seconds, and every 60 seconds after the first 10 minutes. It reports when every run for
  the commit has completed on two checks in a row (workflows of one push don't all appear at once).
- No run for the commit within 10 minutes: it reports that no CI run started. After 2 hours it reports that CI
  is still running and stops. Failed API calls are retried; five in a row end the watch with a report.
- It signs in with the editor's existing GitHub or Microsoft session, a token in the environment or a `gh` /
  `az` login, and never shows a sign-in prompt.

The report says how many runs passed and failed, names the failed jobs and steps, and for failures carries the
error messages and the last log lines of each failed step (about 4000 characters in all, the same excerpt
`pipeline_report` reads), then asks the agent to investigate and fix the failure if its change caused it. In the
chat it appears under a **CI watcher** heading rather than as a message from you; while a watch runs, an info
row says what it is watching.

Where the report goes depends on the conversation when CI ends:

| Conversation                                  | What happens                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Open and idle                                 | The report starts a new turn.                                                       |
| Open, agent mid-turn or waiting for approval  | The report is queued (it shows under the input box) and runs when the turn ends.    |
| Running in the background                     | The report is queued on that task, which keeps it running.                         |
| Not loaded in this window                     | A notification with **Open**; the report is sent when you open the conversation.    |

Limits:

- One watch per conversation. A new `watch_ci` call replaces the previous watch; deleting the conversation
  stops it.
- At most 5 reports in a row wake a conversation without a message from you, so a fix → push → watch loop can't
  run unattended for ever. The sixth is shown as a notification and a chat row instead, saying why; any message
  you send resets the count.
- Watches live in memory: reloading or closing the window loses them, and a report that was waiting for its
  conversation to be opened.
- Turning `plinycode.ci.watch` off removes the tool and stops the running watches.

To watch many pull requests and branches at once, with one status per pipeline and prompts that fix them, use
the [CI Board](ci-board.md).

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
(on-premises / TFS) is auto-detected from a `_git` path segment on any host that isn't `dev.azure.com` or
`*.visualstudio.com`, so it needs no `DEVOPS_MCP_PROVIDER` setting; sign in with `AZURE_DEVOPS_PAT` (on-premises
servers are usually PAT-only, not Azure AD). The editor only sees an environment variable that was set before it
started, so restart it (every window) after setting the PAT. A server that was renamed and redirects its old host
name to the new one (a clone's remote still says `tfs.ansys.com`, the server now answers as
`ado.internal.synopsys.com`) keeps working: the credentials follow a redirect that changes only the host. On such
servers the agent learns a PR build's commit from the merge commit it built, since they don't report it.

## Settings

| Setting                                | Default | Meaning                                                           |
| -------------------------------------- | ------- | ----------------------------------------------------------------- |
| `plinycode.devops.enabled`             | `true`  | Run the server.                                                   |
| `plinycode.devops.registerWithEditor`  | `true`  | Offer it to Copilot Chat (VS Code) or Cursor's agent.             |
| `plinycode.ci.watch`                   | `true`  | Offer PlinyCode's agent the `watch_ci` tool.                      |

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
| `ci-watch/`                | `watch_ci`: the watcher, its report, and the per-conversation watches. Runs in the extension host and reuses the server's providers. Delivery into conversations is `src/sdk/sdk-ci-watch-coordinator.ts`. |
| `ci-board/`, `host/CiBoardHost.ts` | The CI Board: many PRs and branches at once, with actions that run prompts in git worktrees. See [ci-board.md](ci-board.md). |

The built-in server is deliberately not in McpHub, which only manages servers from the user's MCP settings
file. Tests: `bun test src/services/devops-mcp` (from `apps/vscode`), which needs `git` on `PATH` but no
network or login.
