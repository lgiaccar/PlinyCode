# Ubuntu desktop test environment

Use a disposable Ubuntu 22.04 or 24.04 x64 VM with a regular sudo-enabled user.
The package tests install and remove PlinyCode Desktop and refuse to overwrite an
existing installation. They never use a real gateway, browser profile or token.
Install the Node and Bun versions in the root `.tool-versions` first.

From the repository root:

```bash
bash apps/desktop/tests/linux/install-deps.sh
bun install --frozen-lockfile
bun run build:sdk
bun -F @plinycode/desktop typecheck
bun -F @plinycode/desktop test
bun -F @plinycode/desktop setup
bun -F @plinycode/desktop build
export PLAYWRIGHT_BROWSERS_PATH="$PWD/ai_output/playwright"
(cd apps/desktop && bun x playwright install chromium)
bash apps/desktop/tests/linux/session.sh bun apps/desktop/tests/linux/credentials.ts
bash apps/desktop/tests/linux/session.sh bun -F @plinycode/desktop test:e2e
bash apps/desktop/tests/linux/session.sh bun -F @plinycode/desktop test:browser
bun -F @plinycode/desktop package:linux
bash apps/desktop/tests/linux/packages.sh
```

`session.sh` starts Xvfb and a separate D-Bus session with a disposable, unlocked
GNOME keyring, isolated HOME and XDG directories. The keyring password is a test
fixture. Artifacts remain under `ai_output/`; do not use real credentials here.
Unit tests also cover absent, locked, unknown and insecure credential backends.
No production code disables Chromium's sandbox or enables plaintext secrets.

Ubuntu 24.04 restricts unprivileged user namespaces. For unpacked Electron and
AppImages, a system administrator must permit the application through AppArmor.
CI applies a test-runner-only policy adjustment; do not disable that policy on a
regular workstation. Prefer the installed `.deb` there.

The matrix runs lifecycle/process cancellation, folder serialization, real Git
worktrees, MCP transports, local GitHub/ADO fixtures, Electron UI with bundled
workers, encrypted storage and restart, and signed-in browser fixtures. Both
packages run the full Electron suite. AppImage uses its extraction runtime in CI;
native FUSE mounts, Wayland, managed Chrome/Edge, and live provider accounts remain
manual acceptance checks. Package replacement is checked with the same version;
cross-version migration needs a second released version.
