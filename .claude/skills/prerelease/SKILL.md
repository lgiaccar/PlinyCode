---
name: prerelease
description: Tick PlinyCode's pre-release version (`<next release>-test.<N>`) on a PR branch, and optionally publish that build as a GitHub pre-release for testers. Use when the user asks to tick the version or the prerelease, bump test.N, or publish or ship a test build or pre-release.
---

# Tick and publish a PlinyCode pre-release

The rules, and why they exist, are in `docs/releasing.md` under "Pre-release version convention" and "Testing a
release before users get it". Read those sections first. For an official release, use the `release` skill instead.

The skill has two parts. Part A only edits the branch and can be redone. Part B pushes a tag and publishes a
GitHub pre-release that testers' editors install automatically, so **confirm with the user before each outward
step in it**.

## When to tick

- Tick on every update of a PR that changes what ships in the extension: code under `apps/vscode` or
  `sdk/packages`. Each update gets a new number, even on the same PR.
- Don't tick for PRs that only change docs, CI or skills: the `.vsix` would be identical.
- Never reuse a number, even one whose pre-release was deleted: an editor that installed it keeps that version.

## A. Tick the version

1. **Bring the branch up to date.** `git fetch origin`, then merge `origin/stage` into the PR branch, so the tick
   starts from everything already on `stage`.
2. **Find the next release.** It's the newest official tag (`git tag -l 'release_*'`, ignoring `-test.` tags)
   with its patch number increased by one: after `release_0.1.4` it is `0.1.5`. Use a minor bump only if the
   user says so.
3. **Find the highest `N` already used for it.** Local tags are often stale, and numbers are taken on other PR
   branches before they reach `stage`, so check all of these:
   - tags: `git fetch --tags origin`, then `git tag -l 'release_<next>-test.*'`
   - GitHub releases: `gh release list --repo lgiaccar/PlinyCode --limit 30`
   - open PRs: for each `headRefName` from `gh pr list --repo lgiaccar/PlinyCode --state open --json headRefName`,
     read `version` from `git show origin/<branch>:apps/vscode/package.json`
   - `stage` itself: `git show origin/stage:apps/vscode/package.json`

   The new version is `<next>-test.<highest N + 1>`, or `<next>-test.1` if none is used yet.
4. **Set it.** Change `version` in `apps/vscode/package.json`, then run `bun install` so the `plinycode-dev` entry
   in `bun.lock` follows. `git diff` must show exactly two changed lines: those two `version` fields.
5. **Commit** as `Tick pre-release version to <version>`, in its own commit. Put the version at the end of the PR
   title in parentheses, e.g. `Send now reaches the agent right away (0.1.5-test.2)`.

## B. Publish the pre-release (only when the user asks)

1. **Preflight.** `gh auth status` must succeed; if not, ask the user to run `gh auth login`. The working tree
   must be clean, and the version commit must be pushed.
2. **Tag, then push the tag (confirm first).** `git tag release_<version>` on the version commit (`HEAD`). After
   the user confirms, `git push origin release_<version>`. Push only the tag: the branch goes through its PR.
3. **Package.** `cd apps/vscode && bun run release:package`. It writes
   `apps/vscode/dist/release/<version>/PlinyCode-<version>.vsix` and prints its sha256.
4. **Write the notes** in `apps/vscode/dist/release/<version>/README.md`, following
   `.claude/skills/release/release-notes-template.md`. Testers read them: say what changed in this build and what
   to try. Show them to the user.
5. **Publish (confirm first).** From `apps/vscode`:
   ```sh
   bun run release:publish -- --prerelease --dry-run
   ```
   Show the user the output. After they confirm:
   ```sh
   bun run release:publish -- --prerelease
   ```
   `--prerelease` keeps it off `/releases/latest`, so only editors with `plinycode.updates.prerelease` on get it.
   Never pass `--force` unless the user asks for it. If publishing fails partway, report which step failed; don't
   delete releases or tags yourself.
6. **Report** the version, the sha256 and `https://github.com/lgiaccar/PlinyCode/releases/tag/release_<version>`.
   Remind the user that testers need **Install pre-releases** on (PlinyCode **Settings → About**) and can run
   **PlinyCode: Check for Updates** to get it straight away.
