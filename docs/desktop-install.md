# Download and install PlinyCode Desktop

[Desktop 0.1.1 downloads](https://github.com/lgiaccar/PlinyCode/releases/tag/desktop-v0.1.1)
include a per-user Windows x64 installer, Ubuntu x64 DEB and AppImage, and `SHA256SUMS`.
Electron and Bun are bundled. Access to Pliny and a Pliny API key are required.
Git is required for worktrees and PR publishing.

## Windows

1. Download `PlinyCode-Desktop-Setup-0.1.1-x64.exe` and `SHA256SUMS`.
2. In PowerShell, compare `Get-FileHash .\PlinyCode-Desktop-Setup-0.1.1-x64.exe -Algorithm SHA256`
   with the matching line in `SHA256SUMS`.
3. Double-click the installer. No administrator rights are needed. Launch **PlinyCode Desktop**
   from the desktop or Start menu if it does not open automatically.
4. Open Settings and configure your Pliny API key, or reuse securely stored CLI credentials.
   Choose a project folder and start a chat. FreeAuto is the default model.

The preview installer is unsigned, so Windows may show an unknown-publisher warning.

## Ubuntu 22.04 / 24.04 x64

Download the DEB or AppImage and `SHA256SUMS` into the same folder. Verify the downloaded
asset with `sha256sum --check --ignore-missing SHA256SUMS` before installing it.

For the DEB:

```bash
sudo apt install ./PlinyCode-Desktop-0.1.1-x64.deb
plinycode-desktop
```

For the AppImage:

```bash
chmod +x PlinyCode-Desktop-0.1.1-x64.AppImage
./PlinyCode-Desktop-0.1.1-x64.AppImage
```

Use a normal graphical desktop session with GNOME Keyring/Secret Service available
for securely stored credentials. AppImage also needs FUSE support. See the
[desktop guide](https://github.com/lgiaccar/PlinyCode/blob/desktop-v0.1.1/docs/desktop.md)
for Linux setup, browser companion setup and platform limitations.

## Updating an existing installation

**Desktop 0.1.0 and 0.1.1 do not update automatically.** There is no in-app update check.
Download each new Desktop version manually. The VS Code extension has a separate updater.

- Windows: close Desktop and run the new installer as the same user. Do not uninstall first.
- DEB: close Desktop and run `sudo apt install ./<new-package>.deb`.
- AppImage: close Desktop, make the new file executable and launch it; update any shortcut
  to point to the new file.

The app identity and saved-data location are unchanged. Upgrades retain projects,
conversations, settings and credentials. Interrupted tasks still require explicit resume.
For an extra backup, copy the Desktop data folder while the app is closed:
`%APPDATA%\PlinyCode\desktop` on Windows or `${XDG_CONFIG_HOME:-$HOME/.config}/PlinyCode/desktop`
on Linux. Credentials remain in the OS credential store; copying the data folder does
not transfer them to another computer.
