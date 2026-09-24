# Releasing PlinyCode

PlinyCode is not on the VS Code Marketplace or Open VSX. It updates itself from two sources:

1. **GitHub Releases** (primary): <https://github.com/lgiaccar/PlinyCode/releases>. Needs no login or setup, and
   works on Windows, macOS, Linux and Remote-SSH hosts.
2. **The shared `PlinyCodeRelease` OneDrive folder** (fallback and archive):
   <https://synopsys-my.sharepoint.com/:f:/p/lgiaccar/IgBld6NhNTGwSb_WqFxvTLOSAd5IkJfiWSM3k3l8jdgrgZw?e=nx2JeG>.
   It's shared with the PlinyCode users Teams group, and used when GitHub can't be reached.

Every release is published to both. In Claude Code, the `/release` skill walks through the steps below.

> **The repository is public**, so GitHub releases (and the `.vsix` files) can be downloaded by anyone.

## What a release contains

**GitHub:** a release tagged `release_<version>` (e.g. `release_0.1.3`), whose description is the release notes.
It has two assets:

- `PlinyCode-<version>.vsix`
- `latest.json`, with URLs pinned to that release's tag:

  ```json
  {
  	"product": "plinycode",
  	"version": "0.1.3",
  	"vsix": "https://github.com/lgiaccar/PlinyCode/releases/download/release_0.1.3/PlinyCode-0.1.3.vsix",
  	"sha256": "<lowercase hex sha256 of the .vsix>",
  	"notes": "https://github.com/lgiaccar/PlinyCode/releases/tag/release_0.1.3",
  	"releasedAt": "2026-09-24"
  }
  ```

The updater fetches `https://github.com/lgiaccar/PlinyCode/releases/latest/download/latest.json`, which GitHub
always serves from the newest published (non-draft, non-prerelease) release.

**OneDrive folder:** the same files, with paths relative to the folder:

```
PlinyCodeRelease/
├── latest.json              ← {"vsix": "0.1.3/PlinyCode-0.1.3.vsix", "notes": "0.1.3/README.md", ...}
├── 0.1.2/
│   ├── PlinyCode-0.1.2.vsix
│   └── README.md
└── 0.1.3/
    ├── PlinyCode-0.1.3.vsix
    └── README.md
```

Never edit a `latest.json` by hand; `bun run release:publish` writes both.

## How auto-update works

The code is in `apps/vscode/src/hosts/vscode/auto-update/`. `release-remote.ts` handles GitHub,
`release-folder.ts` the OneDrive folder, and `AutoUpdater.ts` the checks, install and prompts.

1. About 30 seconds after startup, and every 6 hours after that, the extension reads `latest.json` from both sources:
   - **GitHub:** `plinycode.updates.url`. Downloads use the extension's shared `fetch`, which honours proxy settings
     and retries certificate failures with the bundled Synopsys CAs. The manifest may only point at `https` URLs on
     the same host.
   - **Folder:** `plinycode.updates.folder` if set. Otherwise it looks in the OneDrive roots (`%OneDriveCommercial%`,
     `%OneDrive%`, home-directory folders starting with `OneDrive` or containing `Synopsys`, and on macOS
     `~/Library/CloudStorage/OneDrive-*`) for a folder named, or ending in, `PlinyCodeRelease`. SharePoint needs a
     Microsoft login, so the extension never downloads from SharePoint itself; it only reads what OneDrive has
     synced to disk.
2. It picks the newest version from either source (GitHub wins a tie). If that version is newer than the running
   one, it downloads or copies the `.vsix` into its own storage and checks the sha256. It then installs it and
   offers **Reload Now** and **Release Notes**.
3. If one source fails (network error, or a checksum mismatch because OneDrive is still syncing), it tries the
   other. Otherwise it tries again at the next check.

Automatic checks show nothing unless there is an update. **PlinyCode: Check for Updates** in the Command Palette
always reports a result.

| Setting                     | Default                                                                      | Meaning                                                 |
| --------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| `plinycode.updates.enabled` | `true`                                                                       | Check and install automatically.                        |
| `plinycode.updates.url`     | `https://github.com/lgiaccar/PlinyCode/releases/latest/download/latest.json` | Remote `latest.json`. Empty = use only the folder.      |
| `plinycode.updates.folder`  | `""`                                                                         | Synced `PlinyCodeRelease` folder, if not found automatically. |

**Limits:**
- The updater only installs versions that are **newer** than the running one. It never downgrades.
- **0.1.3** is the first release with the updater. Users on 0.1.2 or earlier install it by hand once.

## One-time setup for users

1. Download `PlinyCode-<version>.vsix` from the newest [GitHub release](https://github.com/lgiaccar/PlinyCode/releases),
   or from the OneDrive folder.
2. Install it: **Extensions → ⋯ → Install from VSIX…**, then reload the window.

That's all; later releases install themselves. Optionally, choose **Add shortcut to My files** on the OneDrive
folder, so updates still arrive if GitHub is blocked on your network.

## Publishing a release

Run these from the repo root unless noted. `/release` in Claude Code does the same.

**Once per machine:** run `gh auth login` with an account that can create releases on `lgiaccar/PlinyCode`.

1. **Branch.** Create `lgiaccar/release_<major>_<minor>_<patch>` from the up-to-date `stage` branch, with a
   clean working tree.
2. **Bump the version.** Set `version` in `apps/vscode/package.json`, then run `bun install` so the `plinycode-dev`
   entry in `bun.lock` matches. The diff should be two lines.
3. **Build and test.**
   ```sh
   bun install
   bun run build:sdk
   bun run types
   bun -F plinycode-dev test:unit
   ```
4. **Commit and tag.** Commit as `Release <version>: bump extension version.`, then tag and push:
   ```sh
   git tag release_<version>
   git push origin <release branch> release_<version>
   ```
   The GitHub release is created from this tag, and publish refuses to run unless the tag is on `origin` and
   points at `HEAD`.
5. **Package.**
   ```sh
   cd apps/vscode
   bun run release:package
   ```
   This runs the production build (`vscode:prepublish`) and writes
   `apps/vscode/dist/release/<version>/PlinyCode-<version>.vsix`, packaged with `README.marketplace.md`.
6. **Write the release notes** in `apps/vscode/dist/release/<version>/README.md`. Follow
   `.claude/skills/release/release-notes-template.md`: what changed for users since the last release (from
   `git log release_<previous>..HEAD`), any upgrade steps, and build info. They become the GitHub release
   description and the folder's `README.md`.
7. **Smoke test.** Install the `.vsix` in VS Code and in Cursor (**Install from VSIX…**), reload, and send one
   message through the Pliny gateway.
8. **Publish.**
   ```sh
   cd apps/vscode
   bun run release:publish -- --dry-run   # runs every check, publishes nothing
   bun run release:publish
   ```
   All checks run before anything is published: `gh` is logged in, the tag is on `origin` and points at `HEAD`,
   no GitHub release exists for the tag yet, and the version is newer than what each source serves. Then:
   - **GitHub:** the release is created as a draft, both assets are uploaded, and only then is it published and
     marked latest, so users never see a half-uploaded release. The script then checks that the `latest.json`
     URL serves the new version.
   - **Folder:** the `.vsix` and notes are copied first and `latest.json` is written last. If the folder isn't
     found, this step is skipped with a warning (`--folder <path>` or `PLINYCODE_RELEASE_FOLDER` point at it).

   `--skip-github` and `--skip-folder` publish to one source only. `--force` allows a version that isn't newer,
   or a tag that isn't `HEAD`.
9. **Open the PR** for the release branch as usual.
10. **Verify.** On a machine running the previous version, run **PlinyCode: Check for Updates**.

## Pulling a bad release

The updater never downgrades, so the fix is always a new, higher version (for example 0.1.4 to replace a broken
0.1.3).

To stop the bad release reaching more people while you fix it:
- **GitHub:** edit the release and tick **Set as a pre-release**. `/releases/latest` then falls back to the
  previous release.
- **Folder:** rename `latest.json` to `latest.json.paused`.

Users who already updated can install the previous `.vsix` by hand. Publishing the fix makes it the latest
release again; delete the `.paused` file then.

## Troubleshooting

- **"Could not check for updates":** neither source was available. The message says why for each source. Usually
  GitHub is blocked and the OneDrive folder isn't synced. Sync the folder, or set `plinycode.updates.folder`.
- **An update never arrives:** open **Output → PlinyCode** and look for `[AutoUpdate]` lines. A checksum mismatch
  from the folder means OneDrive hasn't finished downloading the `.vsix`.
- **The "Reload" prompt comes back after reloading:** the install didn't take effect. Install the `.vsix` by
  hand, and report it.
- **`release:publish` says the tag isn't on origin, or isn't `HEAD`:** push the tag, or check out the tagged
  commit and package again.
