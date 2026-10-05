# Reviewer pass: a second model reads the diff before a run ends

When a FreeAuto or BalanceAuto run that changed files is about to end, a model other than the one that wrote the code reads the diff. If it finds likely defects, they go back to the working model once, as a `[SYSTEM]` reminder: check each item against the code, fix the real ones, and say in the final reply which were dismissed and why. Then the run continues.

The completion judge asks whether the request was carried out ([pliny-free-auto-router.md](pliny-free-auto-router.md)). The reviewer pass asks whether what was written is right. It runs at the same point, after the completion guard and the judge have accepted the reply that would end the run.

The pass can add one round of work to a run. It can never block a finish: a skipped review, a reviewer that times out, fails or answers unreadably, and a cancelled run all end the run as before.

Code: [router-review.ts](../apps/vscode/src/sdk/router/router-review.ts) (reviewer choice, prompt, parsing, the pass), [router-review-diff.ts](../apps/vscode/src/sdk/router/router-review-diff.ts) (what the run changed, skip rules, size cap), wired in [router-integration.ts](../apps/vscode/src/sdk/router/router-integration.ts).

## Setting

`plinycode.review.beforeFinish` (boolean, default `true`). It is read when a run is about to end, so a change applies to the next run without a restart.

## When it runs

All of these must hold:

- the selected model is a router (`auto-free`, `-fast`, `-smart`, `auto-paid-balanced`);
- the mode is Act. Plan and Ask mode are never reviewed;
- it is the root agent's run. The engine consults the completion guard for the root agent only, so a sub-agent's run is never reviewed on its own. Files a sub-agent edited count as changes of the root run and are reviewed there;
- the turn made at least one successful `editor` or `apply_patch` call;
- the turn has not been reviewed yet. One user turn is reviewed at most once: the reply that follows the fix-up is not reviewed again, also when a failed run was recovered in between;
- the completion guard did not give up on the reply. A run that ends on a stall the guard stopped reminding about is unfinished, and the chat already says so;
- on BalanceAuto, the turn's last call ran on a free model. The review itself is free, but the round of checking it sets off is billed when a paid model answers, so the pass stays out there, as the completion guard does.

Then the change itself must be worth reading: at least 3 changed lines of code. Markdown and other prose (`.md`, `.mdx`, `.rst`, `.txt`, `.adoc`, `README`, `CHANGELOG`, …), lockfiles, binary files and files too large to diff are not reviewed. In a mixed change they are named for the reviewer but not shown.

## Where the diff comes from

1. **The run's checkpoint**, when there is one: the snapshot taken when the user's message started the run, compared with the working tree (`SdkCheckpointCoordinator.getRunChanges`, the comparison behind "View Changes"). It has line numbers and includes what shell commands and sub-agents changed.
2. **The run's edit calls**, when there is no checkpoint (the workspace is not a git repository, checkpoints are off), when the comparison takes longer than 10 s, or when it shows nothing because the edits went to git-ignored files. The diff is rebuilt from the inputs of the successful `editor` and `apply_patch` calls. It has no line numbers, and an edit that a later one overwrote still shows.

The diff is capped at about 24,000 characters. The budget is shared out per file, smallest first, so short diffs stay whole. A file that is cut ends with `[… N more lines of this file's diff are not shown]`, files that do not fit at all are named, and the reviewer is told not to report what it cannot see as missing.

## Who reviews

The first healthy, free model of the profile's reasoning route that did not work on the turn, then the rest of the pool in its order. The candidates come from the router's own selection (`selectCandidates`) and health registry, so a rules file that reorders the route or the pool changes the reviewer with it. A model counts as an author when it answered a call of the turn or made one of its edits, in a sub-agent too.

With the built-in rules:

| Profile | Usual author | Reviewer |
| --- | --- | --- |
| `auto-free`, `auto-free-smart` | kimi-k2.6 | qwen3.5-397b, then nemotron ultra |
| `auto-free-fast` | qwen3-coder | qwen3.5-397b, then nemotron ultra |
| `auto-paid-balanced` | kimi-k2.6 | qwen3-coder (the reasoning route is all paid, so the free pool reviews) |

Paid models never review. When no free model other than the authors is healthy, the review is skipped.

A reviewer whose call fails outright counts as a failure in the router's health registry, like a failed routed call. A timeout or an unreadable reply does not.

## What the reviewer is asked

It gets the user's request, the working model's final reply, and the diff, with reasoning switched off and a JSON-only reply, like the judge. It must answer:

```json
{"issues": [{"file": "src/stats.ts", "line": 12, "problem": "…", "why": "…"}]}
```

At most 5 issues, and only defects it is confident about: wrong behaviour, code that will not compile or run, lost or corrupted data, an unfinished stub or placeholder, a requested part that is missing. No style, naming or "consider" remarks, and nothing about code the change did not touch. An empty list is the expected answer.

The parser accepts a fenced or chatty reply, and a bare list of issue objects. The reviewer has 45 s. A timeout, an error or a reply with no usable object counts as "no issues".

Reasoning is off because of what a probe against the live gateway showed on a small diff with two planted defects: the 397B with its default reasoning took 7 to 12 s, found one of the two, and on the clean version spent its whole reply on reasoning and returned no content. With reasoning off it found both in under 2 s and returned an empty list for the clean version.

## What the user sees

Info rows in the chat, like the completion guard's:

- `🔎 qwen3.5-397b-fp8 is reviewing this turn's changes (3 files, +120 −14)` when the review starts;
- then one of `… flagged 2 possible problems (9s) · asked the model to check them`, `… found no problems (4s)`, or `The review by … gave no result (timed out after 45000ms) · finishing without it`.

A skipped review shows nothing.

## Completion guard budgets

The pass is consulted after the guard, and outside it. Its reminder does not count toward the guard's eight reminders per run or its three unanswered ones, does not make the next stall look like a second one in a row, and is not held back when the guard has used up its budget. The reply that follows the fix-up goes through the guard's pattern rules like any other.

## Run log

Each root run's line in `pliny-free-auto-runs.jsonl` carries a `review` object once the run reached its end:

| Field | Meaning |
| --- | --- |
| `outcome` | `issues`, `clean`, `no-verdict` (the reviewer failed) or `skipped` |
| `reason` | for `skipped`: `setting-off`, `not-act-mode`, `paid-model`, `already-reviewed`, `guard-gave-up`, `no-changes`, `docs-only`, `small-change`, `no-reviewer`, `cancelled`, `sub-agent`. For `no-verdict`: the error |
| `model` | the reviewing model |
| `issues` | how many it flagged |
| `durationMs` | how long it took |
| `source` | `checkpoint` or `tool-calls` |
| `files` | files shown to the reviewer |
| `truncated` | `true` when the diff was cut to fit |

A sub-agent's line always says `skipped` / `sub-agent`. A run that ended on an error or was cancelled before its last reply has no `review`.

## Limits

- A turn that changed files only through shell commands (`sed -i`, a code generator, a heredoc) is not reviewed: the trigger is a successful `editor` or `apply_patch` call. Once a review is triggered, the checkpoint diff does include what shell commands changed.
- The checkpoint is the session's latest one. If this turn's snapshot failed, the comparison reaches back to the previous turn's and shows more than this turn changed.
- The reviewer sees the diff, not the repository. It is told not to report as missing what may exist in code it cannot see, and the working model is told the reviewer can be wrong, but a false finding still costs a round of checking.
- Sub-agent edits are counted from the moment the root run started. If a failed run is recovered, edits a sub-agent made before the failure are no longer counted, so a turn whose only edits were those is not reviewed.
- Cancelling the run stops the review at once. A message sent while the reviewer reads waits for it to finish.
