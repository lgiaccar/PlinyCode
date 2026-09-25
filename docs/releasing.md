# Releasing PlinyCode

PlinyCode is not on the VS Code Marketplace or Open VSX. It updates itself from **GitHub Releases**:
<https://github.com/lgiaccar/PlinyCode/releases>. That needs no login or setup, and works on Windows, macOS, Linux
and Remote-SSH hosts.

In Claude Code, the `/release` skill walks through the steps below.

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
always serves from the newest published (non-draft, non-prerelease) release. Until an official release exists,
that URL answers 404.

Never edit a `latest.json` by hand; `bun run release:publish` writes it.

## How auto-update works

The code is in `apps/vscode/src/hosts/vscode/auto-update/`. `release-remote.ts` talks to GitHub,
`release-manifest.ts` parses `latest.json` and checks downloads, and `AutoUpdater.ts` runs the checks, install and
prompts.

1. About 30 seconds after startup, and every 6 hours after that, the extension reads:
   - **The official release:** `latest.json` from `plinycode.updates.url` (empty means the default URL).
   - **GitHub pre-releases**, only with `plinycode.updates.prerelease` on (see
     [Official releases and pre-releases](#official-releases-and-pre-releases)).

   Requests use the extension's shared `fetch`, which honours proxy settings and retries certificate failures
   with the bundled Synopsys CAs. The manifest may only point at `https` URLs on the same host.
2. It picks the newest version found (the official release wins a tie). If that version is newer than the running
   one, it downloads the `.vsix` into its own storage and checks the sha256. It then installs it and offers
   **Reload Now** and **Release Notes**.
3. If a check fails, it tries again at the next one.

Automatic checks show nothing unless there is an update. **PlinyCode: Check for Updates** in the Command Palette,
or the **Check for Updates** button in PlinyCode's **Settings → About**, always reports a result: an update, "up to date" (with the newest version on GitHub when that is older than the
running one), "no release published yet", or why GitHub couldn't be reached.

| Setting                        | Default                                                                      | Meaning                                                       |
| ------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `plinycode.updates.enabled`    | `true`                                                                       | Check and install automatically.                              |
| `plinycode.updates.prerelease` | `false`                                                                      | Also install `-test.N` pre-releases (developers and testers). |
| `plinycode.updates.url`        | `https://github.com/lgiaccar/PlinyCode/releases/latest/download/latest.json` | `latest.json` of the newest official release.                 |

### Official releases and pre-releases

By default an editor gets **official releases only** (`0.1.3`, `0.1.4`, …): `/releases/latest` never serves a
pre-release, so a `-test.N` build can't replace an official install.

Developers and testers turn on **Install pre-releases** in PlinyCode's **Settings → About**, or tick
`plinycode.updates.prerelease` in VS Code's Settings. Both control the same user setting, so it persists across
restarts (and follows Settings Sync). With it on, the updater also reads
`https://github.com/lgiaccar/PlinyCode/releases.atom`, tries the newest five `release_*` versions in order, and
offers the first whose `latest.json` exists. Turning it on checks immediately and reports the result. When
**Check for Updates** finds no official release, it offers **Include Pre-releases**, which turns the setting on.

- **Pre-releases and releases share one track.** `0.1.4-test.1` < `0.1.4-test.2` < `0.1.4` < `0.1.5-test.1`, so a
  tester moves to each official release automatically when it ships, then on to the next pre-release.
- **Turning it off never downgrades.** An editor on `0.1.4-test.2` stays there until `0.1.4` (or later) ships, then
  follows official releases only.
- **The feed, not `api.github.com`.** GitHub's API allows 60 anonymous requests an hour per IP address, and one
  office behind one proxy address uses that up; the feed on github.com has no such limit. If the feed can't be
  read, the updater still installs official releases.

**Limits:**
- The updater only installs versions that are **newer** than the running one. It never downgrades.
- **0.1.3** is the first release with the updater. Users on 0.1.2 or earlier install it by hand once.
- **0.1.0** used a different extension ID (`synopsys-plinycode.claude-dev`; later releases are
  `synopsys-plinycode.plinycode-dev`), so VS Code keeps both installed side by side, and they clash over the same
  commands. On startup, PlinyCode uninstalls the old `claude-dev` build if it finds it, then offers a reload
  (`legacy-extension.ts`).

## One-time setup for users

1. Download `PlinyCode-<version>.vsix` from the newest [GitHub release](https://github.com/lgiaccar/PlinyCode/releases).
2. Install it: **Extensions → ⋯ → Install from VSIX…**, then reload the window. If you still have PlinyCode
   0.1.0, it's removed automatically; reload again when asked.

That's all; later releases install themselves.

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
   description.
7. **Smoke test.** Install the `.vsix` in VS Code and in Cursor (**Install from VSIX…**), reload, and send one
   message through the Pliny gateway.
8. **Publish.**
   ```sh
   cd apps/vscode
   bun run release:publish -- --dry-run   # runs every check, publishes nothing
   bun run release:publish
   ```
   All checks run before anything is published: `gh` is logged in, the tag is on `origin` and points at `HEAD`,
   no GitHub release exists for the tag yet, and the version is newer than the published one. Then the release
   is created as a draft, both assets are uploaded, and only then is it published and marked latest, so users
   never see a half-uploaded release. The script then checks that the `latest.json` URL serves the new version.

   `--force` allows a version that isn't newer, or a tag that isn't `HEAD`.
9. **Open the PR** for the release branch as usual.
10. **Verify.** On a machine running the previous version, run **PlinyCode: Check for Updates**.

## Testing a release before users get it

GitHub's `/releases/latest` never serves a **pre-release**, so a pre-release reaches only the editors that turned
on **Install pre-releases** (`plinycode.updates.prerelease`; see
[Official releases and pre-releases](#official-releases-and-pre-releases)).

### Pre-release version convention

Pre-releases are numbered `<next release>-test.<N>` and tagged `release_<version>`:

| Build | Version | Tag |
| --- | --- | --- |
| first pre-release of 0.1.3 | `0.1.3-test.1` | `release_0.1.3-test.1` |
| each later one | `0.1.3-test.2`, `0.1.3-test.3`, … | `release_0.1.3-test.3` |
| the release | `0.1.3` | `release_0.1.3` |
| first pre-release of the next one | `0.1.4-test.1` | `release_0.1.4-test.1` |

- **Always `test`.** The updater compares the text after `-` alphabetically, so a different word can sort below
  a build testers already have: `0.1.3-dev.9` and `0.1.3-rc.1` are both *older* than `0.1.3-test.2`, and an
  editor on `test.2` would never update to them.
- **Tick `N` by one for every pre-release**, and never reuse a number, even after deleting a pre-release: an
  editor that installed it keeps that version. The number is compared numerically, so `test.10` follows `test.9`.
- **The release itself sorts above all its pre-releases**, so testers move to `0.1.3` automatically once it ships,
  and `0.1.4-test.1` sorts above `0.1.3`.

1. On a throwaway branch, set a pre-release version such as `0.1.3-test.2`, commit, then tag and push only the
   tag: `git tag release_0.1.3-test.2 && git push origin release_0.1.3-test.2`. Pre-release versions sort below
   the real `0.1.3`, so testers move to the real release automatically once it ships.
2. `bun run release:package`, write the notes, then `bun run release:publish -- --prerelease`. This marks the
   GitHub release as a pre-release, leaves it unmarked as latest, and checks that
   `/releases/latest` still serves the current release.
3. Editors with **Install pre-releases** on install it at their next check, or straight away on
   **PlinyCode: Check for Updates**. To test without touching your own install, use a separate profile:
   `code --user-data-dir <tmp>/user-data --extensions-dir <tmp>/extensions`. Install the older build there, put
   `"plinycode.updates.prerelease": true` in `<tmp>/user-data/User/settings.json`, and start it. About 30 s later,
   `code --user-data-dir … --extensions-dir … --list-extensions --show-versions` shows the new version.
4. A throwaway pre-release can be deleted afterwards, with its tag:
   `gh release delete release_0.1.3-test.2 --repo lgiaccar/PlinyCode --cleanup-tag`, then
   `git tag -d release_0.1.3-test.2`.

## Pulling a bad release

The updater never downgrades, so the fix is always a new, higher version (for example 0.1.4 to replace a broken
0.1.3).

To stop the bad release reaching more people while you fix it, edit the release on GitHub and tick **Set as a
pre-release**. `/releases/latest` then falls back to the previous release. Editors with pre-releases on would
still see it, so also delete the release's `latest.json` asset; the updater skips releases without one. The same
step pulls a bad pre-release.

Users who already updated can install the previous `.vsix` by hand. Publishing the fix makes it the latest
release again.

## Troubleshooting

- **"Could not check GitHub for updates: …":** the request failed; the message gives the reason (proxy,
  certificate, timeout, HTTP error). Check that `github.com` is reachable from the editor.
- **"No official PlinyCode release is published on GitHub yet":** `/releases/latest` has nothing to serve,
  because every release is a pre-release (or has no `latest.json`). Publish an official release, or choose
  **Include Pre-releases**.
- **"Up to date", but you expected an update:** the message names the newest version on GitHub. If it is older
  than yours, the build you're running was never published as a release.
- **An update never arrives:** open **Output → PlinyCode** and look for `[AutoUpdate]` lines.
- **The "Reload" prompt comes back after reloading:** the install didn't take effect. Install the `.vsix` by
  hand, and report it.
- **`release:publish` says the tag isn't on origin, or isn't `HEAD`:** push the tag, or check out the tagged
  commit and package again.
