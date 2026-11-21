#!/usr/bin/env bash
# A disposable HOME, D-Bus service and unlocked fixture keyring. Never use real secrets.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../../.." && pwd)
mkdir -p "$root/ai_output"
if [[ "${PLINY_TEST_SESSION:-}" != 1 ]]; then
  session=$(mktemp -d "$root/ai_output/linux-session-XXXXXX")
  export HOME="$session/home" XDG_CONFIG_HOME="$session/config"
  export XDG_DATA_HOME="$session/data" XDG_CACHE_HOME="$session/cache"
  export XDG_RUNTIME_DIR="$session/runtime" PLINY_TEST_SESSION=1
  export XDG_CURRENT_DESKTOP=GNOME GNOME_KEYRING_CONTROL="$session/keyring"
  # Keep Playwright's downloaded browsers discoverable after isolating HOME.
  export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$root/ai_output/playwright}"
  mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" "$GNOME_KEYRING_CONTROL"
  chmod 700 "$XDG_RUNTIME_DIR" "$GNOME_KEYRING_CONTROL"
  exec dbus-run-session -- xvfb-run -a -s '-screen 0 1440x1000x24' bash "$0" "$@"
fi
printf 'fixture-keyring-password' | gnome-keyring-daemon --unlock --components=secrets --control-directory="$GNOME_KEYRING_CONTROL"
printf 'fixture-value' | secret-tool store --label='PlinyCode test' service plinycode-linux-test
[[ $(secret-tool lookup service plinycode-linux-test) == fixture-value ]]
secret-tool clear service plinycode-linux-test
exec "$@"
