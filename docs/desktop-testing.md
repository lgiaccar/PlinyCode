# Desktop regression and stress testing

Run tests from the repository root with the pinned Bun version. All fixtures live
under ignored `ai_output/`. Tests use isolated Electron/Chromium profiles, temporary
Git repositories, local model/provider fixtures and fixture credentials. They must
not replace an existing Desktop installation or attach to personal browser tabs.

## Commands

```sh
bun run build:sdk
bun -F @plinycode/desktop setup
bun -F @plinycode/desktop build
bun -F @plinycode/desktop typecheck
bun -F @plinycode/desktop test
bun -F @plinycode/desktop test:e2e
bun -F @plinycode/desktop test:drafts
bun -F @plinycode/desktop test:browser
```

Install Chromium with `bun x playwright install chromium` from `apps/desktop`
before the browser test. Set `PLAYWRIGHT_BROWSERS_PATH` to the root
`ai_output/playwright` directory for an isolated download. On Ubuntu, use
`apps/desktop/tests/linux/install-deps.sh` and wrap Electron/browser commands with
`bash apps/desktop/tests/linux/session.sh` to provide Xvfb and an isolated keyring.

The `desktop-test` workflow runs on Windows and Ubuntu 22.04/24.04. It includes
unit/protocol tests, both Electron suites, browser companion acceptance, native
package installation/removal and actual Windows self-update. Its optional
`previous-installer-run` input adds an upgrade from an earlier CI installer.

## Regressions reproduced in the November 2026 stress pass

| Defect | Regression coverage |
| --- | --- |
| New chats inherited a different chat's draft; selecting a chat discarded unsent text | `drafts-e2e.ts`: separate drafts survive repeated switching |
| Delayed attachments or send acknowledgements could affect another/newer draft | Real delayed native dialog plus revision-based `drafts.test.ts` assertions |
| Filesystem-root projects were not recognized as overlapping their descendants | `stress.test.ts`: root, nested and sibling-prefix boundaries |
| A prepared worktree bypassed another task's folder lease | Scheduler regression plus three bursts of mixed folder/worktree tasks |
| Stop released a background command's folder before the process exited | `commands.test.ts`: delayed process termination retains its lease |
| PR creation could enter while prompt restart already owned the task | Node protocol test verifies publishing is rejected and the original lock retained |
| Cached startup failed for init-plus-remote repositories or used a stale default branch | Real Git fixtures fetch, go offline, change the remote default and retry cached startup |

The burst test submits 24 tasks across four folders in each of three waves. Four
queued tasks per wave are cancelled. Workers acquire an exclusive file in their
working folder, so concurrent writers fail visibly. Each wave must finish with
20 completions, four cancellations, no failures and no live task workers.

Existing suites additionally cover restart context and discarded turns, legacy
project migration, dirty-source preservation, approvals and Full Automatic,
credential redaction, background descendants, browser pairing/tab ownership,
MCP transports, GitHub/Azure PR fixtures, update hashes and saved-history upgrades.

These are deterministic local-service acceptance tests. They do not certify a
live Pliny gateway, corporate proxy, production GitHub/Azure permissions, or a
managed Chrome/Edge policy. Keep those environment-specific checks separate.
