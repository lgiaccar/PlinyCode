# Agent monitor

Open **Pipelines → Agents** to monitor multiple Azure DevOps agent pools per workspace.
Keep the locally saved URL or paste the project's agent-pool settings URL,
including `queueId`, choose
authentication, and select **Start monitoring**. The monitor resolves the queue
to its underlying pool; queue and pool IDs need not be identical.

Use **Add pool** to configure another pool, then **Start monitoring** or **Save pool**
to keep it stopped. The **Agent pool** selector switches between pools and shows
which are monitoring, stopped, or have a connection error. Each pool has its own
URL, authentication, filters, notifications and refresh schedule. Draft edits are
preserved while switching pools. **Refresh**, **Stop monitoring**, and **Remove pool**
apply only to the selected pool. Removing a pool stops it and deletes its saved
configuration; it does not change anything in Azure DevOps.

Existing single-pool configurations migrate automatically, including whether
monitoring was enabled. Saved pools resume independently after restart. Removing
every pool leaves the list empty; the old monitor is not recreated.

Starting or saving a monitor stores its URL as the local default for new
workspaces. Existing workspace settings take precedence. Upgrading an installation
with one distinct saved pool URL also offers that URL in new workspaces. A fresh
installation starts with an empty field: internal addresses are never bundled
into the extension or published source. The URL remains editable.

On a local Windows extension host, **Windows sign-in** uses your Windows account
through Windows PowerShell's integrated authentication. This works with Azure
DevOps Server installations that accept Windows authentication. It does not use
browser cookies. For other hosts or Azure DevOps Services, choose **Personal
access token / existing DevOps sign-in** to use PlinyCode's existing
[DevOps authentication](devops-mcp.md). The account needs permission to read the
agent pool. The workspace must be trusted.

Capability filters match names from both system and user capabilities. Enter
comma-separated exact names or prefixes ending in `*`; an agent matching any
filter is included. Matching is case-sensitive. Defaults are `BUILD_*`,
`PERFORMANCE`, and `FFI_BUILD_*`. An empty filter includes every agent.
Capability values are discarded, except that the system `Agent.OS` value is
mapped to an allowlisted Windows, Linux or macOS icon. Missing or unrecognized
values show an unknown-OS marker; agent names are not used to guess the OS.

The list shows connection status, enabled state, assigned-job availability,
matching capabilities, and links to Azure DevOps. Busy means Azure DevOps reports
an assigned request. Busy agents show the pipeline name and run name, plus the
job name when supplied by the server. Click the pipeline to open its run (or the
pipeline page when only that link is available). Shared pools can run pipelines
from other projects; run links use the request's project. Missing details are
shown as **Pipeline name unavailable** and do not prevent status monitoring.
Idle does not guarantee eligibility for a particular pipeline's demands. Search
matches agent names, pipeline/run/job names, and capabilities without changing monitoring.

Refresh runs approximately every minute while the extension host is running,
including when this view is closed. Failures back off to five minutes. **Refresh**
requests an immediate check. Failed requests keep the last successful snapshot
and mark its values as last known; they do not mark agents offline. A failing or
slow pool does not block other pools.

Each agent shows **Utilization (24h)**: estimated busy time divided by its observed
online and enabled time over the last 24 hours. The row shows both busy time and
observed coverage, for example **25.0% · 15m busy / 1.0h observed**. This is job
occupancy, not CPU or RAM load. The first sample shows **collecting samples…**.
Samples are taken at successful refreshes; the preceding busy/idle state applies
to the interval until the next sample. Jobs shorter than the polling interval can
be missed. Offline or disabled transitions, failed polls, monitoring pauses,
restarts and gaps longer than two polling intervals do not add observed time.
History is saved locally per workspace and pool, survives reloads, and expires
after 24 hours. Changing a pool URL or removing a pool clears its history.

Optional VS Code notifications report online/offline and enabled/disabled changes,
including connection changes on disabled agents. Each alert identifies its pool and shows the previous
and new values; simultaneous changes appear together. The first observation,
unknown connection statuses, and filter changes do not trigger connection alerts.
Enabled/disabled changes still notify when the connection status is unknown.
Notifications do not report every poll or busy/idle change.

**Save monitor** applies edited settings. **Stop monitoring** stops the saved
monitor without applying unsaved edits. Configuration is saved per workspace and
resumes after restart; snapshots remain in memory. Monitoring requires PlinyCode's
DevOps integration and an active extension host. Opening the same workspace in
multiple windows can produce notifications in each window.
