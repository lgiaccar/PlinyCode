#!/usr/bin/env bash
# Run only on an Ubuntu test VM/runner. Installs the headless desktop test stack.
set -euo pipefail
. /etc/os-release
[[ "$ID" == ubuntu && ( "$VERSION_ID" == 22.04 || "$VERSION_ID" == 24.04 ) ]]
audio=libasound2
fuse=libfuse2
if [[ "$VERSION_ID" == 24.04 ]]; then audio=libasound2t64; fuse=libfuse2t64; fi
sudo apt-get update
sudo apt-get install -y xvfb xauth dbus-x11 gnome-keyring libsecret-tools \
  libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 libatspi2.0-0 libgbm1 \
  "$audio" "$fuse" xdg-utils git desktop-file-utils libarchive-tools
