# PlinyCode Desktop preview

PlinyCode Desktop is under development in `apps/desktop`. This first implementation
provides a Windows and Ubuntu x64 desktop shell with projects, saved chats, a default FreeAuto
engine worker, permissions and worktrees. It is not the complete desktop release
described in the [implementation plan](desktop-plan.md).

## Windows one-click installer

Download `PlinyCode-Desktop-Setup-0.1.9-x64.exe` from the
[Desktop 0.1.9 release](https://github.com/lgiaccar/PlinyCode/releases/tag/desktop-v0.1.9) and open it.
It installs for the current user without administrator rights, creates desktop
and Start menu shortcuts, and launches PlinyCode when installation finishes.
Electron and Bun are bundled; users do not need to install Node or Bun.

This preview is unsigned, so Windows may display an unknown-publisher or
SmartScreen warning. Desktop 0.1.9 checks for updates automatically and offers
**Download** and **Install and restart** in the sidebar. Installation waits until
running tasks, background commands and PR operations have stopped. Checks can be
disabled in Settings. Versions 0.1.0 and 0.1.1 need one manual upgrade to receive
the updater. The [download and upgrade guide](desktop-install.md) explains the
Windows, DEB and AppImage flows and how saved data is preserved.
On first launch, configure a Pliny API key in Settings (or reuse CLI credentials).
Git is still required for Git worktrees and PR publishing. Current source builds
include the right-side browser described below. The published installer above
predates that feature; existing Chrome/Edge sessions use the companion setup.

Uninstall through Windows **Installed apps**. Conversation history and credentials
are preserved. To rebuild the installer from the prepared source tree:

```powershell
bun -F @plinycode/desktop package
```

The Windows CI workflow builds and tests the installer and attaches it as
`PlinyCode-Desktop-Windows-x64`. Local packaging never publishes a release.

## Ubuntu x64 packages

Ubuntu 22.04 and 24.04 are the initial Linux targets. The desktop CI builds
`.deb` and `.AppImage` artifacts on both versions. Electron and Bun are bundled;
Git is required for worktrees and publishing. Build Linux packages on Linux so the
bundled worker runtime matches the host:

```bash
bun -F @plinycode/desktop package:linux
```

Install the Debian package with `sudo apt install ./PlinyCode-Desktop-0.1.0-x64.deb`;
launch **PlinyCode Desktop** from the applications menu or run `plinycode-desktop`.
Remove it with `sudo apt remove plinycode-desktop`. History remains under
`~/.config/PlinyCode/desktop` (or your XDG configuration directory).

For a portable installation, make `PlinyCode-Desktop-0.1.0-x64.AppImage` executable
and run it. The pinned AppImage runtime supports extraction on hosts where FUSE
mounting is unavailable; use
`APPIMAGE_EXTRACT_AND_RUN=1 ./PlinyCode-Desktop-0.1.0-x64.AppImage`.
Ubuntu 24.04 AppArmor policy may require an administrator to allow user namespaces
for the AppImage; prefer the installed Debian package. Do not disable the Chromium
sandbox as a workaround.

Secure credentials require an unlocked desktop keyring. The Debian package installs
GNOME Keyring and `libsecret-tools`; AppImage users should install these themselves.
Log into a desktop session with the keyring unlocked. Desktop refuses insecure
plaintext fallback. The Pliny API key shares the CLI's Secret Service entry;
provider and MCP secrets use Electron's OS-backed encryption. Environment-injected
`PLINY_API_KEY` remains available for runs without saved gateway credentials.

See the [Ubuntu test environment](../apps/desktop/tests/linux/README.md) for the
repeatable VM setup, isolated keyring, acceptance matrix and package lifecycle
checks. Published preview packages support in-app updates; the packages are not code-signed.
Native Wayland and managed-browser deployment require further manual acceptance.

## Run from source

Use the Bun version in `.tool-versions` and Node 22.12 or newer:

```powershell
bun install --frozen-lockfile
bun run build:sdk
bun run desktop
```

The desktop command downloads the pinned Electron runtime if necessary, builds
the app and launches it. Bun is copied into the build for agent workers. Later
launches can use `bun -F @plinycode/desktop start` after building once.

## Multi-folder projects

**Add project** lets you select several folders together. To extend an existing
project, open **Project settings**, choose **Add folders…**, optionally give the
project a name, then **Save project** and start a new chat. A chat can read, search,
edit and run commands across all of its folders. The first folder remains the
default command directory; the agent receives the complete folder list and uses
absolute paths for the other folders. It is instructed to read and respect each
folder's repository instructions before working there.

Multi-folder chats edit the selected folders directly. Tasks with any overlapping
folder wait for each other, including while background commands remain active.
The chat header lists folders for opening in the file manager, and **Review diff**
shows each folder's Git changes separately. Worktrees and the built-in **Create PR**
control remain available for single-folder Git projects.

Folder changes apply to new chats. Existing chats retain their original folders,
including after restart. Removing an additional folder from a project does not
delete files or remove it from old chats. The primary folder stays first; create a
new project to use a different primary folder. Stop project tasks and background
commands before saving project settings. An unavailable folder causes the chat to
fail before starting the agent, rather than silently running with a partial project.
Existing single-folder projects and saved chats remain compatible.

## What works in this preview

- Add a project with one or more folders and create multiple conversations.
- Send requests to FreeAuto or choose a concrete Pliny model from the catalog.
- Attach file references with the native file picker. The agent reads selected
  paths using its normal file/image tools and the task's permissions; this does
  not add document conversion or inline image previews.
- Stream responses and see tool activity; answer questions and approve/deny tools.
- Give each task its own permission checkboxes, initialized from app defaults.
  Full Automatic selects every category and permits enabled tools automatically.
- Run independent tasks concurrently. Tasks using an ordinary project folder
  hold that folder for the whole run, including when a write needs approval later.
- Git is optional. Ordinary folders run directly without initializing a repository,
  and tasks sharing a folder are serialized.
- Git projects use isolated task worktrees. In project settings, choose **Worktree
  source → Local branch** to start from a local commit without a remote or fetch.
  Leave **Worktree base branch** empty for the current local branch, or name another
  local branch. Uncommitted source changes are not copied or modified. The selected
  branch must have at least one commit.
- Newly added Git projects with no remotes select **Local branch** automatically.
  On startup, older projects without a saved source setting also select **Local
  branch** when no remotes exist. Explicit source selections are preserved.
  Retry a previously failed prompt using **Edit and restart**. An explicitly
  remote project can still switch to **Local branch** in project settings.
- Projects using **Fetched remote branch** retain the fresh-fetch behavior. The
  remote default branch is discovered unless overridden; a separate checkbox
  explicitly permits using the last fetched revision. Missing remotes produce an
  actionable configuration error. PR publishing still requires a configured remote.
- Review tracked changes and list new files; open the task folder externally.
- Save chat history and engine sessions. Send a new message after reopening to
  continue. A crashed active task is marked interrupted; it never restarts itself.
- Unsent drafts stay separate when switching chats and survive app restarts. Delayed
  file selections belong to the chat that opened the picker; sending a prompt
  clears only the submitted draft revision. Drafts are saved separately from model
  history, and closing the app waits for in-flight draft saves.
- While a task runs, keep typing and choose **Steer task** (or Enter) to deliver a
  correction at the next engine boundary, or **Queue follow-up** for a separate
  turn after successful completion. Pending messages show whether they are queued
  or waiting for the agent; received steering appears in the conversation. Up to
  20 messages can wait per task. Steering does not undo an action already underway
  or answer a pending permission request. Stop, failure and reopening hold pending
  messages for review instead of automatically replaying them. Use **Move to draft**
  or **Remove** to manage messages that are not currently being delivered.
- Streaming follows the latest reply while you are at the bottom. Scrolling up
  keeps your reading position; **Jump to latest** resumes following. Reading
  positions are remembered per chat while the app is open.
- HTTP and HTTPS links in replies open in the system browser. Desktop validates
  the URL again in its main process and rejects embedded credentials and other
  protocols. Local file links remain plain text.
- Copy any prompt or response with **Copy**, or select text and use the native
  right-click menu or keyboard shortcuts. User prompts preserve their original
  whitespace and Markdown source.
- Choose **Edit and restart** on an earlier prompt, edit it and click **Restart
  from here**. This replaces the prompt and removes later turns from the active
  chat and model context. Files and external actions are not reverted. Stop the
  task and its background commands first. The previous chat is saved under
  `tasks/<task-id>/restarts/` in Desktop's data folder. New turns keep exact
  pre-turn model snapshots, including tool results; older chats use a unique
  matching prompt in persisted model history. If an older prompt was compacted
  away or is ambiguous, restart from the first prompt or copy it into a new chat.
- Stop a task or exit the app to stop its worker and owned command descendants.
  Workers also stop their process trees when the host connection disappears.
- Use delegation with configurable concurrency/depth, independent FreeAuto
  routing state, saved child transcripts, live tool activity and token totals.
- Start managed background commands through the agent. Commands continue across
  follow-up turns; expand their panel to read recent output or stop a command.
  Output is capped at 100,000 characters per command. Another task using the same
  ordinary folder waits until these commands stop. Cancel/exit stops them too.
- Configure, edit, enable, test and remove stdio, HTTP and SSE MCP servers in
  Settings. Connection tests can launch the configured program. Task connections
  ask first unless the task's MCP permission is enabled. MCP tools inherit that
  permission, including when called by sub-agents.
- Open **Browser** in the sidebar for an embedded browser beside the chat. Agents
  can navigate, read, click and fill in this browser without companion setup.
- Pair the Chrome/Edge companion with an existing signed-in browser and share
  selected tabs. Agents can list shared tabs, inspect page text and controls,
  click, fill and navigate within a shared origin. Web access controls approvals.
- Configure GitHub, Azure DevOps cloud or Azure DevOps Server PR credentials per
  project. Review a task's branch/target/changes, optionally commit its changes,
  push and create a draft or ready PR. Refresh status and open the resulting PR.

### Right-side browser

Choose **Browser** in the sidebar or ask the agent to open an HTTP/HTTPS URL.
The pane has an address bar, back/forward, reload/stop and a width slider. Closing
the pane hides it without discarding the page; app settings and review dialogs
temporarily hide the native page so it cannot cover their controls.

The agent's `browser` tool uses `tabId: 0` (also the default) for the embedded
browser. `navigate` opens `url`; `read` and its `snapshot` alias return page text
and numbered controls; `click` uses `ref`; `fill` uses `ref` and `text`. Read again
after navigation or a page change. Each read replaces the previous references.
`tabs` also lists shared companion tabs; their nonzero IDs keep routing to the
external browser. `release` releases the task's tabs. **Web access** controls tool
approval, including for the embedded browser; Full Automatic approves it.

Only one task at a time owns the embedded browser, until release or turn end.
Choose **Take control** before interacting manually, then **Allow agent** when
finished. Address-bar navigation, back/forward and reload also take manual control.
Takeover interrupts an outstanding agent operation; it does not undo a submitted
form or other action already performed. The agent must inspect uncertain results
before retrying.

The embedded browser uses its own in-memory session, separate from Desktop and
Chrome/Edge. Sign-ins last until app exit. Password entry and file selection are
manual; automatic password/file filling, downloads, pop-up windows, privileged URL
schemes and website permission requests are not supported. Reading and interaction
currently cover the main document, not iframe or shadow-DOM controls. Use the
companion for existing signed-in Chrome/Edge tabs. Corporate SSO/proxy compatibility
still requires managed-device acceptance.

Settings and history are stored in `%APPDATA%/PlinyCode/desktop`. Engine state is
separate for each task. Worktrees are retained under this folder until explicitly
managed; automatic cleanup is not implemented yet. The original checkout is never
reset, staged or automatically updated by worktree creation.

Pliny credentials use the same DPAPI store as the CLI. Set `PLINY_API_KEY`, use
`plinycode auth login`, or save the key in Desktop settings. The environment key
takes precedence. Desktop history/settings remain separate from CLI and extension
data. Known gateway credentials are redacted from displayed model responses.
New engine transcripts, compaction sidecars, SQLite writes and hook audits redact
known gateway credentials and configured MCP credential values. This does not
rewrite older data, sanitize arbitrary documents, or guarantee that all sensitive
content has been removed. The redaction policy is isolated to each task process.

MCP environment/header values are stored encrypted with Electron's OS credential
facility (DPAPI on Windows), separately from public settings. Stored values are
never returned to the renderer. In the MCP editor, leaving the encrypted-values
field blank keeps existing values; submitting empty `env`/`headers` objects clears
them. Keep credentials out of endpoint URLs and command arguments. Changed server
settings apply to the next run; active runs keep their existing connections.

## Browser companion setup

1. In Desktop Settings, click **Open companion folder**. In Chrome's or Edge's
   extensions page, enable Developer mode and **Load unpacked** from that folder.
2. Copy the extension's ID into Desktop's **Browser extension ID** field and
   click **Start pairing**. Copy the address and pairing token into the companion
   popup, then click **Connect**. The password field supports selecting/copying.
3. Open the tab you want to automate, click the companion toolbar button and
   **Share current tab**. This uses the browser's `activeTab` grant; the shipped
   extension has no blanket website-access permission.
4. Ask a task to use the browser. Enable **Web access** to approve browser actions
   automatically, or approve each call. Full Automatic also enables this category.
5. Use **Stop sharing current tab** or **Disconnect** to revoke access. Desktop
   exit disconnects automation and leaves browser tabs open. Re-pair after restart.

Pairing uses an authenticated, origin-checked WebSocket bound only to a random
loopback port. Tokens stay in memory; neither a remote API nor a native-host
registry installation is needed. Only the configured extension ID can connect.
Each tab is leased to one top-level task at a time; its sub-agents share the lease.
Leases end on explicit release, turn completion or disconnect. Navigation to a
different origin requires sharing again. After an interrupted action, inspect
the page before retrying because a click may already have taken effect.

The initial DOM adapter supports the top-level document. Iframes, screenshots,
download management, file uploads and password entry are not implemented.
Managed organizations may restrict unpacked extensions; deployment on intended
managed devices remains an acceptance prerequisite. The heartbeat follows the
[Chrome extension WebSocket lifecycle guidance](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets).

## Pull request controls

Open **Project settings** and configure a provider, API/collection URL, owner
(GitHub) or project (Azure), repository name and access token. GitHub uses its
REST API; Azure supports API versions 6.0, 7.0 and 7.1 for Server/cloud deployments.
For Azure cloud, enter the organization URL; for Server, enter the collection URL
including its collection path. HTTPS and trusted certificates are required outside
loopback test fixtures. This preview uses PATs/tokens, not interactive SSO or NTLM.

Tokens are encrypted in the desktop vault and never passed to the agent worker.
Leaving a token blank retains it only for unchanged provider settings; changing
the destination without a new token clears the old credential. Git fetch/push
continues to use your existing Git authentication and configured author identity.

After a worktree task finishes, click **Create PR**. The dialog shows the branch,
push remote, uncommitted paths and commits. Its target defaults to the task's
starting branch, with the project's separate PR-target override applied. Review
the diff before selecting **Commit all task changes**; that option stages every
change in the task worktree and commits using the PR title. Publishing never
force-pushes, merges, or modifies the source checkout. Stop background commands
and delegated agents before publishing. Provider settings must match the Git push
remote, including the repository name.

Alternatively, explicitly ask the parent agent to create a PR. With Full Automatic
enabled it can commit, push and create without another tool approval. Delegates
can inspect PR status but leave publication to their parent. With fewer permissions
the create tool asks for approval. Existing open PRs are returned without creating
duplicates or republishing later changes; updating an existing PR is future work.

Creation progress is persisted before network calls. A lost response or crash
during creation is **uncertain**, not automatically retried. Use **Refresh PR
status** to reconcile it. If no PR appears, inspect the provider before checking
the explicit retry box. Refresh also distinguishes open, closed and merged PRs.
Provider implementations follow the [GitHub PR API](https://docs.github.com/en/rest/pulls/pulls)
and [Azure PR API](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/create?view=azure-devops-rest-7.1).

## Remaining release work

Managed-browser deployment, explicitly authorized live-provider acceptance,
image upload/preview, worktree cleanup and production signing are tracked in the
[plan](desktop-plan.md). Browser and provider fixtures do not establish compatibility
with a company's browser policies, Git authentication or Azure Server installation.

Desktop packages are published on GitHub Releases under separate `desktop-v*` tags.
The updater discovers stable Desktop tags and verifies platform update metadata before installation. The one-click installer remains a preview without production signing.
PDF, Word, Excel and dedicated data processing are deferred.

## Improve prompt

Click **Improve prompt** beside Send to rewrite the draft for spelling and clarity
using a free utility model. It sends only the draft, with no conversation history
or tools, and does not execute or send your request. **Undo improvement** restores
the original. Editing, sending or changing chats invalidates pending rewrites so
late results cannot replace newer text. Drafts over 8,000 characters are left intact;
failed requests time out after 20 seconds and preserve the draft. The task's model
selection, including FreeAuto, is unchanged.

Starting with 0.1.3, prompt improvement uses Electron's native networking to honor
the operating system's certificate trust and proxy settings. This fixes the
20-second timeout that could occur on corporate connections in 0.1.1/0.1.2.
Certificate verification remains enabled. Timeout and cancellation have separate messages.

## Validation

See the [Desktop stress-test guide](desktop-testing.md) for reproduced bugs,
concurrency scenarios and the isolated Windows/Ubuntu test environment.

```powershell
bun -F @plinycode/desktop typecheck
bun -F @plinycode/desktop test
bun -F @plinycode/desktop build
bun -F @plinycode/desktop setup
bun -F @plinycode/desktop test:e2e
bun -F @plinycode/desktop test:drafts
cd apps/desktop
bun x playwright install chromium
cd ../..
bun -F @plinycode/desktop test:browser
```

Tests use temporary Git repositories and a local gateway, never live credentials.
The Electron suite exercises the actual worker, permission prompts, Full Automatic
editing, history reopening, cancellation, folder serialization, background commands,
actual delegation, MCP settings/authentication and an on-disk redaction scan.
Transport tests cover stdio, HTTP and SSE, including connection timeouts. Process
tests cover command ownership, folder leases, host-pipe loss, shutdown and
interrupted-state recovery. CI tests installers and self-update on clean runners;
live gateway/provider acceptance and managed-machine installation remain separate.
Screenshots and test history remain under `ai_output/desktop-e2e-*` for inspection.

`PLINY_DESKTOP_DATA` changes the data directory for isolated development. The E2E
test also uses `PLINY_DESKTOP_TEST_PROJECT` to supply a fixture folder without an
interactive folder picker. Neither setting is required for ordinary use.

## Suggested next prompts

After a completed turn, an empty composer can show a gray, context-aware follow-up.
Tab accepts it into the draft without sending; Escape dismisses it. See
[next prompt suggestions](next-prompt-suggestions.md).
