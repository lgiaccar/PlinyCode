---
name: release
description: Cut and publish a PlinyCode release to the shared PlinyCodeRelease OneDrive folder that the extension auto-updates from. Bumps the version, builds, tests, packages the .vsix, writes release notes, tags, and publishes latest.json. Use when the user asks to release, ship or publish a new PlinyCode version.
disable-model-invocation: true
---

# Release PlinyCode

The full process, and the reasons behind it, are in `docs/releasing.md`. Read it first. This skill is the
checklist for running it.

The release folder is shared with every PlinyCode user, and publishing to it updates their editors
automatically. **Publishing (step 9) and pushing (step 8) are outward-facing: confirm with the user before
each one.** Everything before that is local and can be redone.

## 1. Decide the version

- Read the current `version` in `apps/vscode/package.json` and the newest `release_*` tag (`git tag -l 'release_*'`).
- Ask the user whether this is a patch or minor release, unless they already said so. Propose the next version.

## 2. Branch

- The working tree must be clean (untracked `.claude/worktrees/` is fine). If it isn't, stop and ask.
- `git fetch`, then create `lgiaccar/release_<major>_<minor>_<patch>` from the up-to-date `stage` branch,
  unless the user names another base.

## 3. Bump the version

- Set `version` in `apps/vscode/package.json`.
- Run `bun install` and check that `git diff` only changes the `version` in `apps/vscode/package.json` and the
  `plinycode-dev` entry in `bun.lock`.

## 4. Build and test

```sh
bun install
bun run build:sdk
bun run types
bun -F plinycode-dev test:unit
```

Stop on any failure and report it with the output. Engine tests that fail only because `bash`, `bun` or network
access is missing are environment artifacts (see AGENTS.md); say so rather than hiding them.

## 5. Package

```sh
cd apps/vscode && bun run release:package
```

This writes `apps/vscode/dist/release/<version>/PlinyCode-<version>.vsix` and prints its sha256.

## 6. Write the release notes

- Collect the changes: `git log --no-merges release_<previous>..HEAD`, plus the merged PR descriptions where
  commit subjects are too terse.
- Write `apps/vscode/dist/release/<version>/README.md` from `release-notes-template.md` next to this file.
  The readers are PlinyCode users, not developers: describe what changed for them, group it by feature, and
  leave out internal refactors, tests and CI.
- Include upgrade steps whenever users must do something (reset a file, change a setting).
- Show the notes to the user and apply their edits before publishing.

## 7. Smoke test

Ask the user to install the `.vsix` in VS Code and in Cursor (**Extensions → ⋯ → Install from VSIX…**), reload,
and send one message. You can't do this yourself; wait for their go-ahead.

## 8. Commit, tag, push (confirm first)

- Commit: `Release <version>: bump extension version.` with a short body listing the highlights, ending with
  the attribution line required by the session.
- Tag: `git tag release_<version>`.
- After the user confirms: push the branch and tag, and open the PR against the branch they name.

## 9. Publish (confirm first)

```sh
cd apps/vscode
bun run release:publish -- --dry-run
```

Show the user the dry-run output: the release folder, the currently published version, the new version and the
sha256. After they confirm:

```sh
bun run release:publish
```

If the folder isn't found, ask the user for its path and pass `--folder <path>`. Never pass `--force` unless the
user asks for it.

## 10. Wrap up

Tell the user:
- the version published, the sha256, and the tag;
- to wait for OneDrive to finish syncing, then run **PlinyCode: Check for Updates** on a machine with the
  previous version to confirm the update arrives;
- if this is the first release with the auto-updater (0.1.3), that users on older versions must install it by
  hand once, and where to point them (`docs/releasing.md`, "One-time setup for users").
