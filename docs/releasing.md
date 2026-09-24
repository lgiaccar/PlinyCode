# Releasing PlinyCode

PlinyCode is not on the VS Code Marketplace or Open VSX. Releases live in one shared OneDrive folder,
**`PlinyCodeRelease`**, and the extension updates itself from it.

- **Release folder:** <https://synopsys-my.sharepoint.com/:f:/p/lgiaccar/IgBld6NhNTGwSb_WqFxvTLOSAd5IkJfiWSM3k3l8jdgrgZw?e=nx2JeG>
  (shared with the PlinyCode users Teams group; users have read access, publishers have edit access)
- **Publisher's local copy:** `%OneDriveCommercial%\PlinyCodeRelease`
  (for example `C:\Users\lgiaccar\OneDrive - Synopsys, Inc\PlinyCodeRelease`)

In Claude Code, the `/release` skill walks through every step below.

## Folder layout

```
PlinyCodeRelease/
├── latest.json              ← points at the newest release; the updater reads only this
├── 0.1.2/
│   ├── PlinyCode-0.1.2.vsix
│   └── README.md            ← release notes, shown by the "Release Notes" button
└── 0.1.3/
    ├── PlinyCode-0.1.3.vsix
    └── README.md
```

Old version folders stay in place, so anyone can install an earlier release by hand.

`latest.json`:

```json
{
	"product": "plinycode",
	"version": "0.1.3",
	"vsix": "0.1.3/PlinyCode-0.1.3.vsix",
	"sha256": "<lowercase hex sha256 of the .vsix>",
	"notes": "0.1.3/README.md",
	"releasedAt": "2026-09-24"
}
```

`vsix` and `notes` are relative to the release folder and cannot point outside it. Never edit this file by
hand; `bun run release:publish` writes it.

## How auto-update works

The updater lives in `apps/vscode/src/hosts/vscode/auto-update/`.

1. SharePoint needs a Microsoft login, so the extension cannot download from the link directly. Instead, each
   user syncs the folder with OneDrive once, and the extension reads the files from disk.
2. About 30 seconds after startup, and every 6 hours after that, the extension looks for a synced
   `PlinyCodeRelease` folder that contains `latest.json`. It searches:
   - `plinycode.updates.folder`, if set (then nothing else is searched);
   - the OneDrive roots: `%OneDriveCommercial%`, `%OneDrive%`, folders in the home directory whose names start
     with `OneDrive` or contain `Synopsys`, and on macOS `~/Library/CloudStorage/OneDrive-*`;
   - in each root, a folder named `PlinyCodeRelease`, or ending in it (for example
     `Luigi Giaccari - PlinyCodeRelease` when synced with **Sync** instead of **Add shortcut to My files**).
3. If `latest.json` names a newer version than the running one, the extension copies the `.vsix` into its own
   storage and checks the sha256. It then installs the copy and offers **Reload Now** and **Release Notes**.
4. If the checksum doesn't match (usually because OneDrive is still syncing the file), the copy is discarded
   and the next check tries again.

Automatic checks show nothing unless there is an update. **PlinyCode: Check for Updates** in the Command Palette
always reports a result, and explains the setup when the folder isn't found.

Settings:

| Setting                     | Default | Meaning                                                    |
| --------------------------- | ------- | ---------------------------------------------------------- |
| `plinycode.updates.enabled` | `true`  | Check and install automatically.                           |
| `plinycode.updates.folder`  | `""`    | Path to the synced `PlinyCodeRelease` folder, if not found automatically. |

**Limits:**
- The updater only installs versions that are **newer** than the running one. It never downgrades.
- It doesn't work over Remote-SSH or on Linux, where there is no OneDrive sync. Those users install by hand.
- **0.1.3** is the first release with the updater. Users on 0.1.2 or earlier install it by hand once.

## One-time setup for users

1. Open the release folder link above and choose **Add shortcut to My files**. (**Sync** also works.)
2. Wait for OneDrive to show the folder on disk, e.g. `C:\Users\<you>\OneDrive - Synopsys, Inc\PlinyCodeRelease`.
3. Install the newest `.vsix` from it once: **Extensions → ⋯ → Install from VSIX…**, then reload.
4. Optional: run **PlinyCode: Check for Updates** to confirm it finds the folder.

## Publishing a release

Run these from the repo root unless noted. `/release` in Claude Code does the same.

1. **Branch.** Create `lgiaccar/release_<major>_<minor>_<patch>` from the up-to-date `stage` branch, with a
   clean working tree.
2. **Bump the version.** Set `version` in `apps/vscode/package.json`, then run `bun install` so the
   `plinycode-dev` entry in `bun.lock` matches. The diff should be two lines.
3. **Build and test.**
   ```sh
   bun install
   bun run build:sdk
   bun run types
   bun -F plinycode-dev test:unit
   ```
4. **Package.**
   ```sh
   cd apps/vscode
   bun run release:package
   ```
   This runs the production build (`vscode:prepublish`) and writes
   `apps/vscode/dist/release/<version>/PlinyCode-<version>.vsix`, packaged with `README.marketplace.md`.
5. **Write the release notes** in `apps/vscode/dist/release/<version>/README.md`. Follow
   `.claude/skills/release/release-notes-template.md`: what changed for users since the last release (from
   `git log release_<previous>..HEAD`), any upgrade steps, and build info.
6. **Smoke test.** Install the `.vsix` in VS Code and in Cursor (**Install from VSIX…**), reload, and send one
   message through the Pliny gateway.
7. **Commit and tag.** Commit as `Release <version>: bump extension version.` and tag it
   `release_<version>` (e.g. `release_0.1.3`). Push the branch and tag, and open the PR as usual.
8. **Publish.**
   ```sh
   cd apps/vscode
   bun run release:publish -- --dry-run   # check the folder, the versions and the checksum
   bun run release:publish
   ```
   The `.vsix` and notes are copied first, and `latest.json` is written last, so users are never pointed at
   files that aren't there. The script refuses a version that isn't newer than the published one (`--force`
   overrides). Use `--folder <path>` or `PLINYCODE_RELEASE_FOLDER` if the folder isn't found.
9. **Verify.** Wait until the OneDrive icon shows the files as synced. Then, on another machine running the
   previous version, run **PlinyCode: Check for Updates**.

## Pulling a bad release

The updater never downgrades, so the fix is always a new, higher version (for example 0.1.4 to replace a
broken 0.1.3).

To stop the bad release reaching more people while you fix it, rename `latest.json` in the release folder to
`latest.json.paused`. Updaters then find no release and stay quiet. Users who already updated can install the
previous `.vsix` from its version folder by hand. Publishing the fix writes a new `latest.json`; delete the
`.paused` file then.

## Troubleshooting

- **"Could not find the shared PlinyCodeRelease folder":** the folder isn't synced yet, or it's somewhere
  unusual. Check File Explorer, then set `plinycode.updates.folder` to the folder that contains `latest.json`.
- **An update never arrives:** open **Output → PlinyCode** and look for `[AutoUpdate]` lines. A checksum
  mismatch means OneDrive hasn't finished downloading the `.vsix`.
- **The "Reload" prompt comes back after reloading:** the install didn't take effect. Install the `.vsix` from
  the release folder by hand, and report it.
