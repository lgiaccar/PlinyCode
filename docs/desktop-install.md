# Download and install PlinyCode Desktop

[Desktop 0.1.6 downloads](https://github.com/lgiaccar/PlinyCode/releases/tag/desktop-v0.1.6)
include a per-user Windows x64 installer, Ubuntu x64 DEB and AppImage, and `SHA256SUMS`.
Electron and Bun are bundled. Access to Pliny and a Pliny API key are required.
Git is required for worktrees and PR publishing.

## Windows

1. Download `PlinyCode-Desktop-Setup-0.1.6-x64.exe` and `SHA256SUMS`.
2. In PowerShell, compare `Get-FileHash .\PlinyCode-Desktop-Setup-0.1.6-x64.exe -Algorithm SHA256`
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
sudo apt install ./PlinyCode-Desktop-0.1.6-x64.deb
plinycode-desktop
```

For the AppImage:

```bash
chmod +x PlinyCode-Desktop-0.1.6-x64.AppImage
./PlinyCode-Desktop-0.1.6-x64.AppImage
```

Use a normal graphical desktop session with GNOME Keyring/Secret Service available
for securely stored credentials. AppImage also needs FUSE support. See the
[desktop guide](https://github.com/lgiaccar/PlinyCode/blob/desktop-v0.1.6/docs/desktop.md)
for Linux setup, browser companion setup and platform limitations.

## Updating an existing installation

**Versions 0.1.0 and 0.1.1 need one manual upgrade to 0.1.6.** Close Desktop and
install this package as the same user. Do not uninstall first.

Starting with **0.1.2**, Desktop checks for stable Desktop releases 30 seconds after
startup and every six hours. Use **Check for updates** in the sidebar to check now.
Choose **Download**, then **Install and restart** when ready. It never downloads or
installs without that choice, and installation is blocked while tasks, background
commands or PR operations are active. Automatic checks can be disabled in Settings.

Windows updates use the per-user installer. AppImage updates replace the AppImage;
keep it in a writable folder. DEB updates use the system package manager and may
request administrator authentication. Network and integrity failures leave the
current application installed and offer a retry. Update files are verified against
SHA-512 metadata over HTTPS; these preview installers are still unsigned.

The VS Code extension and CLI have separate release channels. Desktop ignores
editor/CLI releases, drafts, prereleases and older versions.

The app identity and saved-data location are unchanged. Upgrades retain projects,
conversations, settings and credentials. Interrupted tasks still require explicit resume.
For an extra backup, copy the Desktop data folder while the app is closed:
`%APPDATA%\PlinyCode\desktop` on Windows or `${XDG_CONFIG_HOME:-$HOME/.config}/PlinyCode/desktop`
on Linux. Credentials remain in the OS credential store; copying the data folder does
not transfer them to another computer.
