# PlinyCode Desktop

Read the root AGENTS.md and [desktop plan](../../docs/desktop-plan.md).
This package is a Windows and Ubuntu Electron host for the shared engine. Use pinned
Bun; do not import extension services or the CLI's private implementation.

- Electron main owns persisted desktop state and validates renderer requests.
- Renderer has no Node access. Preload exposes only the typed desktop API.
- Run the engine in isolated Bun child processes; engine globals must not leak
  between tasks. Stop owned process trees on cancellation and application exit.
- App defaults initialize task permissions. Full Automatic must genuinely allow
  enabled tools without additional tool approvals. A new app default never
  silently changes existing tasks.
- Top-level tasks have no fixed concurrency cap. Serialize ordinary-folder
  tasks and coordinate conflicting shared resources.
- Git worktrees start from a freshly fetched remote base; cached revisions need
  an explicit choice. Never reset or automatically apply changes to the source.
- Desktop and CLI share credential storage through `@plinycode/shared/node`.
  Never return stored credentials to the renderer or log authentication inputs.
  Configure artifact redaction before starting the engine. Verify new transcript,
  hook audit and database files contain no known fixture credentials. Older files
  and arbitrary user documents are not automatically sanitized.
- Browser companion uses an ephemeral authenticated loopback WebSocket. Keep the
  extension origin/token checks and explicit selected-tab grants; never attach to
  an arbitrary user profile in tests. Browser protocol tests run under Node, as
  Electron main does; the agent tests run under Bun.
- PR controls must verify the task branch and configured push destination, hold
  the task write lease, persist uncertain creation and reconcile before retry.
  Test publishing only against local Git and provider fixtures unless live use
  is explicitly authorized. Keep live deployment and production updating gaps
  visible in docs.
- Rebuild engine packages before desktop checks after shared changes.
- Validate with `bun -F @plinycode/desktop typecheck`, `test`, `build`, then
  `test:e2e` with the Electron runtime installed (`setup`). Linux uses the isolated
  session and package tests in `tests/linux/`; never allow plaintext keyring fallback.
- Scratch and screenshots go under root `ai_output/`; packages go in ignored
  `apps/desktop/release/`. No releases or PRs unless requested.
