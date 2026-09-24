---
name: release
description: Cut and publish a PlinyCode release to GitHub Releases and the shared PlinyCodeRelease OneDrive folder, which the extension auto-updates from. Bumps the version, builds, tests, tags, packages the .vsix, writes release notes and publishes. Use when the user asks to release, ship or publish a new PlinyCode version.
disable-model-invocation: true
---

# Release PlinyCode

The full process, and the reasons behind it, are in `docs/releasing.md`. Read it first. This skill is the
checklist for running it.

Publishing updates every PlinyCode user's editor automatically, and the GitHub repository is public. **Pushing
(step 5) and publishing (step 9) are outward-facing: confirm with the user before each one.** Everything else is
local and can be redone.

## 1. Preflight

- `gh auth status` must succeed. If it doesn't, ask the user to run `gh auth login` (it's interactive, so you
  can't run it for them).
- The working tree must be clean (untracked `.claude/worktrees/` is fine). If it isn't, stop and ask.

## 2. Decide the version

- Read the current `version` in `apps/vscode/package.json` and the newest `release_*` tag (`git tag -l 'release_*'`).
- Ask whether this is a patch or minor release, unless the user already said so. Propose the next version.

## 3. Branch and bump

- `git fetch`, then create `lgiaccar/release_<major>_<minor>_<patch>` from the up-to-date `stage` branch, unless
  the user names another base.
- Set `version` in `apps/vscode/package.json`, run `bun install`, and check that `git diff` only changes that
  `version` and the `plinycode-dev` entry in `bun.lock`.

## 4. Build and test

```sh
bun install
bun run build:sdk
bun run types
bun -F plinycode-dev test:unit
```

Stop on any failure and report it with the output. Engine tests that fail only because `bash`, `bun` or network
access is missing are environment artifacts (see AGENTS.md); say so rather than hiding them.

## 5. Commit, tag, push (confirm first)

- Commit: `Release <version>: bump extension version.` with a short body listing the highlights, ending with the
  attribution line required by the session.
- `git tag release_<version>`
- After the user confirms: `git push -u origin <release branch> release_<version>`.

The publish script requires this tag on `origin`, pointing at `HEAD`. So package from this exact commit, and if
anything changes after tagging, retag before packaging.

## 6. Package

```sh
cd apps/vscode && bun run release:package
```

This writes `apps/vscode/dist/release/<version>/PlinyCode-<version>.vsix` and prints its sha256.

## 7. Write the release notes

- Collect the changes: `git log --no-merges release_<previous>..HEAD`, plus the merged PR descriptions where
  commit subjects are too terse.
- Write `apps/vscode/dist/release/<version>/README.md` from `release-notes-template.md` next to this file. It
  becomes the GitHub release description and the folder's README. The readers are PlinyCode users, not
  developers: describe what changed for them, group it by feature, and leave out refactors, tests and CI.
- Include upgrade steps whenever users must do something (reset a file, change a setting).
- Show the notes to the user and apply their edits.

## 8. Smoke test

Ask the user to install the `.vsix` in VS Code and in Cursor (**Extensions → ⋯ → Install from VSIX…**), reload,
and send one message. You can't do this yourself; wait for their go-ahead.

## 9. Publish (confirm first)

```sh
cd apps/vscode
bun run release:publish -- --dry-run
```

Show the user the dry-run output: the GitHub release tag, the folder, the versions currently published and the
sha256. After they confirm:

```sh
bun run release:publish
```

- If the OneDrive folder isn't found, the script skips it with a warning. Ask the user for its path and rerun
  with `--skip-github --folder <path>`, since GitHub is already done.
- Never pass `--force` unless the user asks for it.
- If publishing fails halfway, report exactly which step failed. The script says what was and wasn't
  published. Don't delete GitHub releases or tags yourself.

## 10. Wrap up

- Open the PR for the release branch if the user wants one.
- Tell the user the version, the sha256, the release URL
  (`https://github.com/lgiaccar/PlinyCode/releases/tag/release_<version>`), and what went to the folder.
- Suggest running **PlinyCode: Check for Updates** on a machine with the previous version.
- If this is 0.1.3, the first release with the auto-updater, remind them that users on older versions must
  install it by hand once (`docs/releasing.md`, "One-time setup for users").
