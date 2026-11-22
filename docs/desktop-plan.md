# PlinyCode Desktop implementation plan

This records the interactive planning decisions and the work still required.
The current deliverable is a local development preview, not a production release.
Implementation is on `lgiaccar/desktop-app`; a PR is now requested, without publication.

## Agreed product scope

- Windows and Ubuntu 22.04/24.04 x64; local execution only for version one.
- Project sidebar, multiple saved chats, background agent tasks and builds/tests.
- No fixed top-level task-count limit. Serialize tasks writing to the same ordinary
  folder; independent coding tasks use separate Git worktrees.
- Default FreeAuto; explicit concrete models supported. Start with CLI behavior
  and selectively add desktop capabilities rather than importing editor state.
- Per-task permission checkboxes copied from app defaults. Selecting all enables
  Full Automatic, including edits, commands, browser, MCP and delegation as each
  capability is implemented. No repeated tool approvals for enabled categories.
- Stop work on app exit, persist conversations, require explicit continuation
  after interruption. Do not blindly repeat uncertain external operations.
- Sub-agents share their parent's worktree and permissions. Keep configurable
  delegation concurrency/depth limits. Coordinate edits to shared files.
- Browser automation uses existing signed-in Chrome/Edge tabs through a companion
  extension and an authenticated loopback WebSocket. The implementation avoids
  a native-messaging host installation. Extension-install acceptance and
  managed-browser feasibility remain to be established.
- Worktrees start from a fresh fetch of the remote default branch, with detailed
  settings for remote/base and a separate PR target. Default PR target is the
  task's starting branch. Fetch failure offers retry or explicit cached-base use.
- The agent infers build/dependency setup from repository instructions.
- Keep work in task branches. Only apply locally on explicit request. A chat
  request or Create PR button triggers commit/push/PR; Full Automatic can carry
  that requested workflow through without further tool prompts.
- Support GitHub, Azure DevOps cloud and company-hosted Azure DevOps Server.
- Share securely stored CLI Pliny credentials; keep desktop settings/history separate.
- MCP settings: add/edit/enable/test stdio, HTTP and SSE servers.
- Per-user Windows installer without admin rights; in-app update checks and
  user-triggered installation. Distribution destination and signing are unknown.

## Delivery checklist

### 1. Desktop foundation

- [x] New Electron/React package and isolated Bun workers.
- [x] Project sidebar, chat navigation, task state and basic diff inspection.
- [x] Shared secure credentials and streaming redaction with the CLI.
- [x] Persistent desktop history and per-task engine storage.
- [x] Per-task permission controls and Full Automatic execution.
- [x] Explicit continuation, cancellation and shutdown of owned worker trees.
- [x] Host-pipe lifetime guards for agent, command and MCP-probe workers;
  Windows fixture verifies loss of the host stops a real shell descendant.
- [x] Real Git worktree preparation from freshly fetched remote bases.
- [x] Ordinary-folder serialization and no fixed independent-task concurrency cap.
- [ ] Complete concurrency/crash/process-tree fault matrix and large-history limits.
- [x] Redact known credentials in newly persisted engine transcripts, compaction
  sidecars, hook audits and SQLite writes; verify by scanning fixture artifacts.
- [ ] Migration/sanitization options for pre-existing artifacts and broader
  sensitive-content handling beyond known credentials.

### 2. Task experience and tools

- [x] Managed background-command executor, output viewer and process controls.
- [x] Persist sub-agent text and expose live tool progress and token totals.
- [x] Independent FreeAuto routing state for each agent instance.
- [ ] Broader delegated-budget, cancellation and concurrent edit stress tests.
- [x] Native file-reference picker and model catalog suggestions.
- [ ] Direct image uploads/previews and image-routing acceptance matrix.
- [ ] Worktree settings UI, cleanup, submodule handling and explicit apply workflow.
- [ ] File conflict protection when parent and sub-agents edit concurrently.

### 3. Browser and MCP

- [ ] Validate companion extension installation on intended managed Windows devices.
- [x] Chrome/Edge companion, selected-tab discovery and signed-in DOM interaction.
  Uses an ephemeral authenticated loopback WebSocket instead of native messaging;
  no registry host installation is required.
- [x] Tab ownership/coordination between tasks and engine tool activity.
- [ ] Screenshots, iframe interaction and richer browser activity visualization.
- [x] Disconnect automation on exit without closing the user's browser.
- [x] MCP configuration, encrypted secrets, connection tests and per-run lifecycle.
- [x] MCP stdio/HTTP/SSE transport fixtures, permission denial, failure reporting,
  actual tool execution and encrypted-storage Electron acceptance tests.
- [x] Browser disconnect/navigation/permission tests, real Chromium signed-in fixture,
  stale-element failures and service-worker heartbeat; Node protocol tests.
- [ ] Managed-device acceptance in actual Chrome and Edge deployments.

### 4. PR providers

- [x] Desktop-owned reusable GitHub/ADO REST adapters without extension imports.
- [x] Encrypted token setup for GitHub, ADO cloud and ADO Server collections.
- [x] Requested commit/push/create PR workflow, preview, configurable targets,
  draft option, refresh/open controls and parent-agent tools.
- [ ] Update an existing PR's branch/content, account SSO and richer review controls.
- [x] Existing-PR reconciliation and explicit retry after uncertain creation;
  interrupted publication is persisted and never automatically replayed.
- [x] API contract/HTTP fixtures, real local Git publication, Electron settings and
  PR preview/status controls, token secrecy, original-checkout protection.
- [ ] Explicitly authorized real-provider acceptance tests.

### 5. Distribution

- [x] Add Ubuntu x64 deb/AppImage targets and Ubuntu 22.04/24.04 CI.
- [x] Add isolated D-Bus/keyring/Xvfb environment and package lifecycle tests.
- [ ] Validate native Wayland, FUSE mounting and managed Linux browser deployment.

- [x] Build Windows x64 one-click NSIS installer with per-user installation,
  shortcuts, launch-on-finish and bundled runtimes; validate installed-app E2E.
- [ ] Validate on a clean Windows machine without development tools.
- [x] Include dependency licenses and notices in distributable artifacts.
- [ ] Decide installer/extension distribution and signing arrangements.
- [x] Implement versioned update metadata, integrity verification and explicit install.
- [x] Verify uninstall removes the test application, shortcuts and registration;
  user-data deletion is disabled in the installer configuration.
- [ ] Verify upgrades across released versions, preserving history and credentials.
- [x] Complete packaged Windows E2E; retain broader release regression checks.

## Deferred backlog

- PDF reading/generation and preview.
- Word reading/generation and preview.
- Excel reading/generation and preview.
- Dedicated data-processing runtime and libraries.
- Rich document previews.
- Other Linux distributions, ARM64, WSL/SSH execution and an external API server.

## Release acceptance

Two coding tasks must run concurrently in distinct worktrees while a build continues
in the background. Permissions must be independent; sub-agents inherit the correct
parent's policy. A requested PR must reach the configured GitHub/ADO target with
Full Automatic enabled. Browser actions must operate in the connected signed-in
session. Cancellation and app exit stop owned commands while preserving recorded
progress. Reopening must never automatically replay unfinished external work.
The installer must run without a separately installed Node/Bun runtime and an
upgrade must preserve existing data. A green fixture suite alone does not establish
live gateway/provider quality or managed-browser deployment compatibility.
