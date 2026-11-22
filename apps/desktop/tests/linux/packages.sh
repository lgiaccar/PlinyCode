#!/usr/bin/env bash
# Destructive package install/uninstall test: use a disposable Ubuntu VM/CI runner.
set -euo pipefail
trap 'echo "Package acceptance failed at line $LINENO" >&2' ERR
root=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$root"
[[ $(id -u) != 0 ]] || { echo 'Run as a regular user with sudo.' >&2; exit 1; }
if dpkg-query -W -f='${Status}' plinycode-desktop 2>/dev/null | grep -q 'install ok installed'; then
  echo 'Refusing to replace an existing PlinyCode Desktop installation.' >&2; exit 1
fi
shopt -s nullglob
debs=(apps/desktop/release/*-x64.deb)
images=(apps/desktop/release/*-x64.AppImage)
[[ ${#debs[@]} == 1 && ${#images[@]} == 1 ]]
[[ $(dpkg-deb -f "${debs[0]}" Architecture) == amd64 ]]
[[ $(dpkg-deb -f "${debs[0]}" Package) == plinycode-desktop ]]
cleanup() { sudo apt-get remove -y plinycode-desktop; }
trap cleanup EXIT
sudo apt-get install -y "./${debs[0]}"
binary=$(command -v plinycode-desktop)
installed=$(readlink -f "$binary")
resources="$(dirname "$installed")/resources"
test -x "$resources/runtime/bun"
"$resources/runtime/bun" --version
test -f "$resources/licenses/THIRD-PARTY-NOTICES.txt"
test -f "$resources/app-update.yml"
[[ $(cat "$resources/package-type") == deb ]]
desktop-file-validate /usr/share/applications/plinycode-desktop.desktop
PLINY_DESKTOP_EXECUTABLE="$binary" bash apps/desktop/tests/linux/session.sh bun -F @plinycode/desktop test:e2e
# Reinstall simulates package replacement; the isolated app state must remain.
sudo apt-get install --reinstall -y "./${debs[0]}"
cleanup
trap - EXIT
test ! -e "$binary"
test ! -e /usr/share/applications/plinycode-desktop.desktop

# Exercise the portable AppImage runtime too, without depending on a FUSE mount.
# The bundled runtime supports APPIMAGE_EXTRACT_AND_RUN on hosts without FUSE.
chmod +x "${images[0]}"
APPIMAGE_EXTRACT_AND_RUN=1 PLINY_DESKTOP_EXECUTABLE="$root/${images[0]}" \
  bash apps/desktop/tests/linux/session.sh bun -F @plinycode/desktop test:e2e
sha256sum "${debs[0]}" "${images[0]}" > ai_output/linux-package-sha256.txt
