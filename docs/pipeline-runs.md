# Pipelines

The **Pipelines** view queues GitHub Actions workflows and Azure DevOps YAML
pipelines connected to repositories in the current workspace. Open it with the
**Pipelines** button in PlinyCode's title bar or the **Pipelines** command.
It is separate from the [CI Board](ci-board.md), which monitors pull requests
and branches rather than individual launches.

## Launching

Select a repository, pipeline and branch or ref. The view reads the pipeline
YAML from that ref and discovers its inputs before **Run** becomes available.
Changing the ref reloads the schema. A detached checkout defaults to the
repository's default branch. For Azure DevOps tags, enter `refs/tags/<tag>`.

- GitHub reads `on.workflow_dispatch.inputs`. Workflows must be active and
  support manual dispatch, including on the default branch. Strings, booleans,
  numbers, choices and environments are supported. Environment names are read
  from the repository's environments API.
- Azure DevOps discovers enabled YAML definitions for the connected repository
  and reads their top-level runtime `parameters`. Strings, booleans, numbers,
  allowed values and JSON object/array values are supported. These are sent as
  `templateParameters`, not pipeline variables.
- Defaults and explicit `false`/`0` values are preserved. Required parameters,
  types and allowed values are validated in the extension host as well as the
  form. The schema revision is checked again before dispatch. If it changes,
  use **Reload pipeline parameters** and review the new values.

Only an explicit **Run** (or a `pipeline_run` call by the agent, see
[Agent-Triggered Launches](#agent-triggered-launches)) queues a pipeline.
Opening the view or loading inputs does not queue anything. Duplicate submissions and transport retries reuse a
launch ID to avoid dispatching the same request twice.

## Run History

History contains launches recorded by PlinyCode, not every run on the provider.
Each entry includes the pipeline, repository, ref, launch time, status/result,
last successful refresh and a provider link. Run IDs are scoped by provider and
repository; two repositories can have runs with the same numeric ID.

Identified active runs refresh roughly every 30 seconds while the view is open
and every 120 seconds in the background. Network failures and low GitHub rate
limits slow refreshing down. Errors preserve the last known status rather than
inventing a failure result. Completed runs stop making status requests.
When a repository's remaining rate limit drops below 100, status requests pause
for five minutes, then allow one recovery probe per repository no more than
every two minutes. Normal polling resumes when the provider reports recovery.

History is workspace-scoped and survives extension restarts. It uses a dedicated
`pipeline-runs` directory in PlinyCode's data directory, with one record per
launch. Launch intent is saved atomically before dispatch, and updates use a
cross-process lock with stale-lock recovery. No input values, credentials or
provider error bodies are persisted in these records.
History retains the newest 200 completed or rejected launches, plus all
unfinished launches so older active runs remain eligible for tracking. Record
reads are batched to avoid unbounded concurrent file I/O.

Polling requires the extension host to be running. Reopening PlinyCode resumes
tracking; it does not replay dispatch requests. A dispatch left pending for
more than five minutes is marked unconfirmed.

## Cancel and Rerun

A launch with a run ID has buttons for its run:

- **Cancel** while it is queued or running. The provider is asked to stop it
  (GitHub's cancel API, an Azure DevOps build set to `cancelling`); the entry
  shows the cancelled result at the next refresh.
- **Rerun** once it has finished, and **Rerun failed jobs** when it failed,
  partly succeeded or was cancelled.

A rerun is a new entry in the history, marked **Rerun**. On GitHub, and for
**Rerun failed jobs** on Azure DevOps, it is a new attempt of the same run ID;
until the provider reports a different finish time it is still showing the
previous attempt, so the entry stays queued rather than repeating the old
result. A full **Rerun** on Azure DevOps queues a new build of the same
definition, branch, variables and template parameters. A refusal (a run that
is still going, missing permissions) is shown under the entry. The agent has the
same operations as the `pipeline_cancel` and `pipeline_rerun` tools (see
[devops-mcp.md](devops-mcp.md#running-pipelines)); those do not add history
entries.

## Notifications

When a run in the history finishes, PlinyCode shows a notification with its
result (an information message for success, a warning otherwise) and **Open
run** and **Open Pipelines** buttons. It covers launches from the form, reruns,
and runs the agent started. The check is the history's own polling, so it needs
no extra requests, and when several windows share the history only the one that
records the result notifies. A run found finished more than a day after its
launch (the window was closed meanwhile) is not announced. Turn the
notifications off with `plinycode.pipelines.notify`.

## Agent-Triggered Launches

PlinyCode's agent queues pipelines with the DevOps server's `pipeline_run` tool
([devops-mcp.md](devops-mcp.md#running-pipelines)). For a repository in the
window, the call goes through the same queueing code as the form: the
pipeline's inputs are read at the ref and validated the same way, the launch is
reserved in the history before dispatch, and it shows as **Started by the
agent**, is tracked and notifies when it finishes. A launch the provider refuses
or does not confirm is reported to the agent as an error. Each call asks for
approval like any MCP tool unless MCP tools are auto-approved, and unattended
CI Board runs may not launch pipelines at all. Launches by other MCP clients
(Copilot Chat, Cursor) are queued directly and are not in the history.

## Unknown Outcomes and Older Hosts

Azure DevOps and current GitHub dispatch APIs return a run ID, which is tracked
directly. GitHub dispatch uses the current API version on github.com without
changing the API version of existing PR/CI operations.

Older GitHub Enterprise APIs may accept a dispatch without returning a run ID.
The launch stays **Awaiting run ID**. Use its provider link to identify the run,
then enter its ID and choose **Link run**. PlinyCode checks the pipeline, ref,
launch time and, for GitHub, the `workflow_dispatch` event before accepting it.
The user explicitly chooses the run; PlinyCode never guesses the newest run.

A timeout, server failure or interrupted response can occur after a provider
has already accepted the request. Such a launch stays **Unconfirmed** and is
never automatically dispatched again. Check the provider before creating
another launch; use **Link run** if it did start.

## Permissions and Limits

Authentication reuses the [built-in DevOps credentials](devops-mcp.md).
Background status checks never prompt for sign-in. When an Azure DevOps Server
needs a personal access token, the error has a **Sign in to Azure DevOps Server**
button, and the pipeline list loads again once a token is stored (see
[devops-mcp.md](devops-mcp.md#azure-devops-server-personal-access-tokens)). Existing tokens must also
have permission to queue runs: GitHub Actions write/repository permissions,
or Azure DevOps build execution permissions. Read access alone is insufficient.
Environment inputs also require permission to list repository environments.

Cancelling and rerunning need the same permissions as queueing (GitHub Actions
write access, Azure DevOps build execution).

The view does not support Azure DevOps classic builds/releases, unrelated
project browsing, queue-time variables or workflow editing.

Azure DevOps `extends` pipelines and structural parameter types such as
`stepList`/`jobList` show an explicit limitation and cannot be queued through
the form. Template-only or cross-repository parameter declarations are not
expanded into a schema; use the provider's run page for those definitions.

## Implementation

- Provider operations: [types.ts](../apps/vscode/src/services/devops-mcp/server/providers/types.ts),
  [github.ts](../apps/vscode/src/services/devops-mcp/server/providers/github.ts),
  [azdo.ts](../apps/vscode/src/services/devops-mcp/server/providers/azdo.ts).
- Agent launches: [pipeline-launch.ts](../apps/vscode/src/services/devops-mcp/pipelines/pipeline-launch.ts)
  (pipeline lookup and input checks for `pipeline_run`) and
  [DevOpsMcpService.ts](../apps/vscode/src/services/devops-mcp/host/DevOpsMcpService.ts)
  (routes PlinyCode's calls to the manager).
- Discovery and lifecycle: [pipeline-inputs.ts](../apps/vscode/src/services/devops-mcp/pipelines/pipeline-inputs.ts),
  [pipeline-manager.ts](../apps/vscode/src/services/devops-mcp/pipelines/pipeline-manager.ts),
  [pipeline-run-store.ts](../apps/vscode/src/services/devops-mcp/pipelines/pipeline-run-store.ts).
- Host lifecycle and notifications: [PipelineHost.ts](../apps/vscode/src/services/devops-mcp/host/PipelineHost.ts).
- RPC: [pipeline.proto](../apps/vscode/proto/cline/pipeline.proto) and
  [controller handlers](../apps/vscode/src/core/controller/pipeline).
- Webview: [PipelinesView.tsx](../apps/vscode/webview-ui/src/components/pipelines/PipelinesView.tsx).

Run focused backend tests with `bun test` from `apps/vscode` against
`src/services/devops-mcp/pipelines/` and the provider test file. Run webview
tests with `bun run test src/components/pipelines/PipelineLaunchForm.test.tsx`
from `apps/vscode/webview-ui`. Follow the
[extension verification guide](../apps/vscode/AGENTS.md) for build/typecheck gates.
