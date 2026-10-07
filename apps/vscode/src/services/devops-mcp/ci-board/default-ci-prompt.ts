/**
 * The CI board's built-in action: make a pull request's CI green and its merge
 * clean. A TypeScript string rather than a .md file because the bundle has no
 * Markdown loader. `{{name}}` placeholders are filled by `renderTemplate`.
 */
export const DEFAULT_CI_PROMPT = `# Get this pull request green

Investigate why CI fails or the merge conflicts, and act on what you find: merge conflict → merge and resolve; build failure → fix the source; test failure → fix or update the tests the way this repository says to. Work only in {{worktree}}.

## Rules

- Read this repository's own instructions first (AGENTS.md, CLAUDE.md, README, .clinerules, skills). Where they describe how to build, test, recalibrate or investigate CI, follow them over this prompt.
- Use the plinycode-devops tools for CI, with \`workspace: "{{worktree}}"\`. Never open a browser to find a PR or a run.
- Never paste whole logs into the conversation. \`pipeline_report\` gives the failed steps and the lines around the error; download more only when one case is genuinely unclear.
- Only push to \`{{sourceBranch}}\`. Never force-push and never rewrite published history.

## Step 0: sync

\`git status\`, then \`git pull --ff-only\`. If the branch has local commits that are not pushed, push them first so CI tests what you are looking at.

## Step 1: merge conflicts

If the merge state says the PR conflicts (or its pipelines never started):

1. \`git fetch {{remote}}\` and \`git merge {{remote}}/{{targetBranch}}\`.
2. Resolve each conflict keeping both intents: the branch's change must survive alongside what landed on \`{{targetBranch}}\`. Do not take one side wholesale.
3. Never hand-merge generated files or data files with measured numbers (lock files, snapshots, test databases): take either side to clear the conflict and regenerate them the way the repository does.
4. Build what you touched if the repository says how, commit ("merge {{targetBranch}} into {{sourceBranch}}: resolve conflicts") and push. The push starts fresh pipelines; go to Step 5.

## Step 2: triage the failures

Call \`pr_checks\` and \`pipeline_runs\` for the PR, then \`pipeline_report\` for each failed run id listed above. For each failed pipeline decide which stage failed:

- **Infrastructure** (agent lost, timeout, network or artifact server errors, "no tests ran" when the binary never started): say so and recommend a re-run. Do not edit code for it.
- **Stale run** (it tested an older commit than the PR head): wait for the run on the current head.
- **Build** → Step 3. **Tests** → Step 4.

## Step 3: build failures

Fix the source for the failing configuration (compiler, platform, flags in the report). Build locally only where the repository documents how and the platform matches yours; otherwise push and let CI validate. Commit and push, then go to Step 5.

## Step 4: test failures

- A real bug in the change: fix it.
- Expected-value or snapshot updates: only through the repository's documented tooling (a recalibration script, a snapshot update command). Never hand-edit measured values.
- Never update expected values for a regression (a metric that got worse, a count of defects that rose, a crash): report it and stop.
- If the repository says nothing about how to update expected values, report the failures and the evidence instead of guessing.

## Step 5: watch

After pushing, call \`watch_ci\` with \`pr: {{prId}}\` and end your turn; you will be woken when CI finishes.

## Step 6: report

Summarise briefly:

- Which pipelines failed and at which stage, with the cause.
- What you changed (conflict resolution, source fix, test updates) and what you pushed.
- A verdict: "fixed, CI running", "needs a re-run (infrastructure)", or "blocked: <what needs a human>".
`
