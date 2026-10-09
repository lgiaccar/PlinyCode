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

Only an explicit **Run** queues a pipeline. Opening the view or loading inputs
does not queue anything. Duplicate submissions and transport retries reuse a
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

History is workspace-scoped and survives extension restarts. It uses a dedicated
`pipeline-runs` directory in PlinyCode's data directory, with one record per
launch. Launch intent is saved atomically before dispatch, and updates use a
cross-process lock with stale-lock recovery. No input values, credentials or
provider error bodies are persisted in these records.

Polling requires the extension host to be running. Reopening PlinyCode resumes
tracking; it does not replay dispatch requests. A dispatch left pending for
more than five minutes is marked unconfirmed.

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
Background status checks never prompt for sign-in. Existing tokens must also
have permission to queue runs: GitHub Actions write/repository permissions,
or Azure DevOps build execution permissions. Read access alone is insufficient.
Environment inputs also require permission to list repository environments.

The first version does not support Azure DevOps classic builds/releases,
unrelated project browsing, queue-time variables, workflow editing, cancellation,
reruns, notifications or agent-triggered launches.

Azure DevOps `extends` pipelines and structural parameter types such as
`stepList`/`jobList` show an explicit limitation and cannot be queued through
the form. Template-only or cross-repository parameter declarations are not
expanded into a schema; use the provider's run page for those definitions.

## Implementation

- Provider operations: [types.ts](../apps/vscode/src/services/devops-mcp/server/providers/types.ts),
  [github.ts](../apps/vscode/src/services/devops-mcp/server/providers/github.ts),
  [azdo.ts](../apps/vscode/src/services/devops-mcp/server/providers/azdo.ts).
- Discovery and lifecycle: [pipeline-inputs.ts](../apps/vscode/src/services/devops-mcp/pipelines/pipeline-inputs.ts),
  [pipeline-manager.ts](../apps/vscode/src/services/devops-mcp/pipelines/pipeline-manager.ts),
  [pipeline-run-store.ts](../apps/vscode/src/services/devops-mcp/pipelines/pipeline-run-store.ts).
- Host lifecycle: [PipelineHost.ts](../apps/vscode/src/services/devops-mcp/host/PipelineHost.ts).
- RPC: [pipeline.proto](../apps/vscode/proto/cline/pipeline.proto) and
  [controller handlers](../apps/vscode/src/core/controller/pipeline).
- Webview: [PipelinesView.tsx](../apps/vscode/webview-ui/src/components/pipelines/PipelinesView.tsx).

Run focused backend tests with `bun test` from `apps/vscode` against
`src/services/devops-mcp/pipelines/` and the provider test file. Run webview
tests with `bun run test src/components/pipelines/PipelineLaunchForm.test.tsx`
from `apps/vscode/webview-ui`. Follow the
[extension verification guide](../apps/vscode/AGENTS.md) for build/typecheck gates.
