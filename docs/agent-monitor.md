# Agent monitor

Open **Pipelines → Agents** to monitor one Azure DevOps agent pool per workspace.
Keep the locally saved URL or paste the project's agent-pool settings URL,
including `queueId`, choose
authentication, and select **Start monitoring**. The monitor resolves the queue
to its underlying pool; queue and pool IDs need not be identical.

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
Capability values are discarded and are not displayed or stored.

The list shows connection status, enabled state, assigned-job availability,
matching capabilities, and links to Azure DevOps. Busy means Azure DevOps reports
an assigned request; idle does not guarantee eligibility for a particular
pipeline's demands. Search narrows the displayed list without changing monitoring.

Refresh runs approximately every minute while the extension host is running,
including when this view is closed. Failures back off to five minutes. **Refresh**
requests an immediate check. Failed requests keep the last successful snapshot
and mark its values as last known; they do not mark agents offline.

Optional VS Code notifications report online/offline and enabled/disabled changes,
including connection changes on disabled agents. Each alert shows the previous
and new values; simultaneous changes appear together. The first observation,
unknown connection statuses, and filter changes do not trigger connection alerts.
Enabled/disabled changes still notify when the connection status is unknown.
Notifications do not report every poll or busy/idle change.

**Save monitor** applies edited settings. **Stop monitoring** stops the saved
monitor without applying unsaved edits. Configuration is saved per workspace and
resumes after restart; snapshots remain in memory. Monitoring requires PlinyCode's
DevOps integration and an active extension host. Opening the same workspace in
multiple windows can produce notifications in each window.
