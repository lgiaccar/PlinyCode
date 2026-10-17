# PlinyCode DevOps (built-in MCP server)

PlinyCode ships an MCP server that lets an agent **create, update and review pull requests**, **read CI pipeline
results** and **start, cancel and rerun pipelines**, on **GitHub** (Actions) and **Azure DevOps** (Repos + Pipelines,
including Azure DevOps Server). It comes with the extension:
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
| `pr_comments`     | Review threads, inline comments, general comments and review verdicts, newest first.          |
| `pr_comment`      | Posts a general comment, an inline comment on a changed line, or a reply in a thread.         |
| `pr_review`       | Approves, requests changes or comments (GitHub review; Azure DevOps reviewer vote).           |
| `pipeline_run`    | Queues a GitHub workflow (`workflow_dispatch`) or an Azure Pipelines YAML pipeline on a branch, with typed inputs. |
| `pipeline_cancel` | Cancels a run that has not finished.                                                          |
| `pipeline_rerun`  | Runs a finished run again, all of it or only its failed jobs.                                 |

The repository comes from the workspace's git remote (`origin`). Every tool also takes a `workspace` argument
with the repository's absolute path. The PR tools take `pr_id`; without it they use the open pull request of the
current branch, and say so when there is none.

`pr_comment`, `pr_review`, `pipeline_run`, `pipeline_rerun` and `pipeline_cancel` act where other people see it.
The server's instructions tell the agent to use them only when you asked for it, and in PlinyCode each call asks for
approval like any MCP tool unless you auto-approve MCP tools. The approval prompt shows the tool's description and
arguments.

`pr_update(section="ci", body=…)` rewrites only the text between `<!-- devops-mcp:ci -->` and
`<!-- /devops-mcp:ci -->`, which don't render, so an agent can keep a generated section current without
touching the hand-written part of the description.

`pr_update(draft=false)` publishes a draft PR (marks it ready for review), and `draft=true` turns it back into a
draft. Azure DevOps takes this as an `isDraft` update. GitHub's REST API can't change the draft status, so on
GitHub the server calls the GraphQL `markPullRequestReadyForReview` or `convertPullRequestToDraft` mutation,
which uses the same token.

Azure DevOps limits PR descriptions to 4000 characters (GitHub: 65536). Longer ones are refused with a message
telling the agent to shorten them; they are never truncated silently.

## Reviewing pull requests

`pr_comments(pr_id?, limit=20)` lists the pull request's threads, the most recently active first (at most 100). Each
shows whether it is an inline thread (`path:line`), a general comment or a review verdict, whether it is resolved, its
last five comments (author, time, the first 300 characters) and the id to pass as `reply_to`:

```text
Comments on PR #7 (GitHub), newest first: 2 of 2 threads, 1 unresolved.

- Inline src/a.ts:12 · unresolved · reply_to: 101
  - jane, 2026-10-05 10:00: Rename this
- General comment
  - bob, 2026-10-01 10:00: LGTM
```

| Provider     | What is listed                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------- |
| GitHub       | Issue comments (general, no `reply_to`: GitHub cannot thread under them), review comments grouped by thread, and reviews with a verdict or a body. The resolved state comes from GraphQL (`reviewThreads`); without GraphQL access the threads are listed without it. |
| Azure DevOps | The PR's threads, without deleted ones and system comments (votes, pushes, policy updates). `active` and `pending` threads are unresolved; `fixed`, `wontFix`, `closed` and `byDesign` are resolved. |

`pr_comment(pr_id?, body, path?, line?, reply_to?)` posts one of:

- a general comment: `body` only;
- an inline comment: `path` (relative to the repository root) and `line` (in the PR's new version of the file).
  GitHub anchors it to the PR's head commit and accepts only lines in the diff. Azure DevOps anchors it to the PR's
  latest iteration and refuses a file the PR does not change before posting anything;
- a reply: `reply_to` with a thread id from `pr_comments`.

`pr_review(pr_id?, verdict, body?)` takes `approve`, `request_changes` or `comment`, on an open pull request only:

| Verdict           | GitHub                                     | Azure DevOps                                                        |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| `approve`         | review with `APPROVE`                      | your vote set to **Approved (10)**                                  |
| `request_changes` | review with `REQUEST_CHANGES` (needs `body`) | your vote set to **Waiting for author (-5)**                      |
| `comment`         | review with `COMMENT` (needs `body`)       | vote unchanged (needs `body`)                                       |

Azure DevOps has no "request changes" vote. `request_changes` maps to **Waiting for author** (-5), which asks the author
for changes like GitHub's verdict does, rather than **Rejected** (-10), which blocks the pull request outright and is
left for a person to cast. On Azure DevOps a `body` is posted as a general comment next to the vote. The vote is cast
as the signed-in user (from `_apis/connectionData`), the same way on Azure DevOps Server.

## Running pipelines

`pipeline_run(pipeline, branch?, inputs?)` names the pipeline by name, id or (GitHub) workflow file name (`build.yml`).
`branch` defaults to the current branch, which must be pushed; a branch with unpushed commits runs the pushed commit
and the result says so. The inputs go through the same discovery and validation as the
[Pipelines view](pipeline-runs.md): the YAML is read at that branch, unknown names and wrong values are refused with the
list of inputs, and text the model sends for a boolean, number, choice or object (`"true"`, `"3"`, JSON text) is turned
into the declared type first.

In PlinyCode, a launch for one of the window's repositories goes through the Pipelines view's queueing code, so it is
recorded in its run history (marked **Started by the agent**), tracked, and announced when it finishes. Copilot Chat,
Cursor and other clients queue through the server directly, without a history entry.

`pipeline_cancel(run_id)` asks the provider to stop a run; a finished run is refused. `pipeline_rerun(run_id,
failed_only=false)` runs a finished run again; a run that is still going is refused, and so is `failed_only` on a run
that succeeded.

| Call                 | GitHub                                   | Azure DevOps                                                                                   |
| -------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| cancel               | `POST actions/runs/{id}/cancel`          | `PATCH build/builds/{id}` with `status: cancelling`                                            |
| rerun, failed only   | `POST actions/runs/{id}/rerun-failed-jobs` (a new attempt of the same run) | `PATCH build/builds/{id}?retry=true` (the same build retries its failed jobs) |
| rerun, everything    | `POST actions/runs/{id}/rerun` (a new attempt of the same run) | `POST build/builds`: a new build of the same definition, branch, variables and template parameters; the same commit, except for a pull request's merge ref, which is rebuilt from the PR's current merge |

## Unattended CI Board runs

Auto-watch runs of the [CI Board](ci-board.md#approvals) run without anyone to approve a call, so their policy
(`apps/vscode/src/sdk/ci-run-policy.ts`) allows the read-only tools, `pr_comments` included, and refuses the others
with a reason the model can act on: `pr_review` (a review is a reviewer's decision), `pr_comment` (such runs do not
create or update pull requests either, so they do not post on them), `pipeline_run` (it can deploy or use shared
capacity; the run's push already triggers CI), `pipeline_cancel` (it can stop someone else's build) and
`pipeline_rerun` (like `gh run rerun`, which the same policy refuses). A board run you started asks you instead.

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
- Turning `plinycode.ci.watch` off removes the tool, stops the running watches and forgets the saved ones.

Reloads:

- Watches survive a window reload, and closing and reopening the window. Every change (a watch starts, its head
  moves, it ends, a report is sent or held, the wake-up count changes) is saved to `ci-watches.json` in
  PlinyCode's data directory, beside the CI Board's `ci-board.json`.
- For each conversation the file keeps the watch (its label, what it watches: the session's working directory,
  the repository's remote, the pull request number or branch, and `until`), the last head commit seen with when
  it was first seen and the earlier head moves, when the watch started and when it gives up, the wake-up count,
  and a report waiting for the conversation to be opened (also one that was still being delivered).
- The file is shared by all windows but split by window workspace, like the CI Board: a window resumes only the
  watches it started.
- On reload the watch carries on where it was: the same 2-hour limit counted from when it started, the same
  head commit, the same wake-up count. Its first check reopens the repository; if the checkout is gone or now
  points at another repository, the checks fail and the watch ends with a report saying so.
- A watch that ran out of time while the window was closed is dropped without a report. A held report is sent
  when its conversation is opened (straight away when it is the one on screen after the reload).
- The watches and held reports of conversations that were deleted (also from another window) are dropped when
  the window starts.

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
`*.visualstudio.com`, so it needs no `DEVOPS_MCP_PROVIDER` setting. A server that was renamed and redirects its old host
name to the new one (a clone's remote still says `tfs.ansys.com`, the server now answers as
`ado.internal.synopsys.com`) keeps working: the credentials follow a redirect that changes only the host. On such
servers the agent learns a PR build's commit from the merge commit it built, since they don't report it.

### Azure DevOps Server (personal access tokens)

An on-premises server takes only a personal access token (PAT). It ignores a Microsoft sign-in and treats such a
request as anonymous (`TF400813: Resource not available for anonymous access`), so for these hosts the server never
asks for one. It tries, in order:

1. The token stored for that host in the editor.
2. `AZURE_DEVOPS_PAT` / `AZURE_DEVOPS_EXT_PAT`. The editor only sees an environment variable that was set before it
   started, so restart every window after setting one.
3. The editor's prompt for a token, when a tool call (not a background poll) needs one.

To store a token from the GUI:

- When the CI Board or the Pipelines view fails because a server needs a token, the error says
  `Azure DevOps Server <host> needs a personal access token` and has a **Sign in to Azure DevOps Server** button
  beside it. The button asks for the token, checks it against the server's `_apis/connectionData` and stores it,
  then checks the board again. A token the server rejects is asked for again; one that can't be checked (no
  network, a proxy) is kept.
- The **PlinyCode DevOps** card in the MCP Servers view lists the hosts with a stored token, with **Replace** and
  **Forget** buttons, and a sign-in button that offers the servers of the open folders.
- The Command Palette has **PlinyCode: Sign in to Azure DevOps Server (personal access token)** and
  **PlinyCode: Forget Azure DevOps Server Token**.

The prompt links to the server's token page (`<collection URL>/_usersSettings/tokens`). The token needs
**Code (Read)** and **Build (Read & execute)**, which also covers starting, cancelling and rerunning pipelines; add
**Code (Read & write)** to let the agent create or update pull requests, comment on them and vote. On GitHub, comments
and reviews need write access to pull requests, and cancelling or rerunning runs needs write access to Actions. Tokens are kept in the editor's secret storage (the OS keychain), one per host, so every window uses a
token as soon as one window stores it. A token is stored under the host in the git remote or pasted link, so a
renamed server reached under both names needs a token for each.

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
- **`TF400813` or "needs a personal access token" on an Azure DevOps Server.** Use the **Sign in to Azure DevOps
  Server** button next to the error, or **Replace** on the DevOps card if the stored token expired.
- **"is not inside a git repository".** The agent passed no `workspace` and the window's first folder isn't a
  git checkout; ask it to pass the repository path.

## For developers

The code is in `apps/vscode/src/services/devops-mcp/`:

| Path                       | Contents                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `server/`                  | The MCP server. No `vscode` import; bundled by `esbuild.mjs` into `dist/devops-mcp.js`.     |
| `server/providers/`        | GitHub and Azure DevOps REST clients behind one `Provider` interface (`ToolProvider` adds the review and pipeline control calls). |
| `pipelines/pipeline-launch.ts` | How `pipeline_run` finds the pipeline and checks its inputs; shared by the server and the extension host. |
| `host/DevOpsMcpService.ts` | Starts the server, tracks its status, feeds its tools to the agent, registers it with the editor. Runs PlinyCode's `pipeline_run` calls in the extension host so they reach the Pipelines view's history. |
| `host/token-broker.ts`     | Local pipe that hands the editor's sign-in tokens to the server process.                   |
| `host/ado-server-tokens.ts` | Azure DevOps Server tokens per host in the editor's secret storage, and the prompt that asks for one. |
| `builtin-mcp-registry.ts`  | How the agent session and the GUI handlers reach the service without importing `vscode`.   |
| `ci-watch/`                | `watch_ci`: the watcher, its report, the per-conversation watches and the file they are saved to (`ci-watch-store.ts`). Runs in the extension host and reuses the server's providers. Delivery into conversations is `src/sdk/sdk-ci-watch-coordinator.ts`. |
| `ci-board/`, `host/CiBoardHost.ts` | The CI Board: many PRs and branches at once, free-model failure triage, actions that run prompts in git worktrees, and auto-watch. See [ci-board.md](ci-board.md). |

The built-in server is deliberately not in McpHub, which only manages servers from the user's MCP settings
file. Tests: `bun test src/services/devops-mcp` (from `apps/vscode`), which needs `git` on `PATH` but no
network or login.
