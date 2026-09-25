# BalanceAuto: paid models for hard work, free ones for the rest

`pliny/auto-paid-balanced` is a fourth router profile beside the three FreeAuto
profiles (`pliny/auto-free`, `-fast`, `-smart`). It runs on the same router
(`apps/vscode/src/sdk/router/`), with one difference: its rules file may name
paid hosted Pliny models. Every call is billed at the concrete model it lands
on; the virtual id itself carries no price.

The ids were `pliny/balance-auto` and `pliny/free-auto[-fast|-smart]` before
0.1.3. The old ids are still accepted everywhere (`canonicalPlinyModelId`), and
a saved selection is rewritten to the new id on activation. The rules and log
file names (`pliny-free-auto.md`, `pliny-balance-auto.md`, ...) are unchanged.

## Where it shows up

The picker gates BalanceAuto with the paid models: it appears only while
**Unlock Pliny paid models** is on in Settings → API configuration. The free
router stays visible regardless. A BalanceAuto selection committed earlier is
kept and shown through the picker's "not in current list" affordance if the
toggle is later switched off; it keeps working.

## Default routing

The classifier is on, so once per turn a small free model reads the request
and returns a tier. The tier picks the route; the keyword heuristics only
decide when the classifier gives no verdict.

| Route | When | Models, best first |
| --- | --- | --- |
| `huge-context` | request ≥ 180k tokens | free GLM-5.2 (512k), vmodels replica first |
| `subagent` | any sub-agent call | free kimi-k2.6, free qwen3-coder, then Haiku 4.5 |
| `plan-and-reasoning` | tier `reason`, or plan mode with a design/review prompt | Claude Sonnet 4.6 high-thinking preset, Claude Sonnet 5, GPT-5.2 |
| `coding` | tier `code`, or act mode with a coding prompt | Claude Sonnet 5, Claude Sonnet 4.6, free qwen3-coder |
| `quick` | tier `quick`, or a short question | free kimi-k2.6, free nemotron super, then Haiku 4.5 |
| `default` | anything else | Claude Sonnet 5, Claude Sonnet 4.6, free kimi-k2.6 |

The pool leads with the paid models, so a turn whose free candidates all fail
still lands on a strong one. Health benching, context-window checks, sticky
choice and failover all behave as for FreeAuto.

Two things the router cannot do for hosted models:

- **Thinking.** Only self-hosted models have a measured reasoning switch, so
  `effort` leaves hosted models at their default. Where thinking is wanted,
  route to a preset such as `aws-bedrock-vmodels/claude-4-6-sonnet-high-thinking`,
  as the reasoning route does.
- **Context beyond 200k.** Hosted entries have no measured window, so they are
  budgeted at the 200k hosted default and a request beyond roughly 118k
  estimated tokens (window minus the output reserve) skips them for a free
  large-context model.

Utility jobs (classifier, compaction summaries, commit messages) stay on free
models by default. The rules file may point any of them at a paid model.

## The rules file

Global: `<data dir>/pliny-balance-auto.md`, created on first activation and
opened with **PlinyCode: Open Routing Rules (FreeAuto / BalanceAuto)** from the
command palette. Workspace override: `<workspace>/.cline/pliny-balance-auto.md`.
The FreeAuto profiles keep their own files, and a project's
`.cline/pliny-free-auto.md` never applies to BalanceAuto, so free-only
overrides cannot displace its paid routes.

The file has the same shape as the FreeAuto one. The differences:

- Any concrete Pliny id is accepted in `pool`, `use` and `utility`; a virtual
  router id is still ignored. The FreeAuto files keep rejecting paid ids.
- The prose under "Guidance for the classifier" tells the classifier which
  tiers are free and which are paid, so it can prefer `quick` for anything a
  small model would finish.

## Watching it work

Chat rows read `BalanceAuto → **global.anthropic.claude-sonnet-5** (call 1 ·
route: coding · classifier: code · ~12k tok)`; sub-agent rows are prefixed with
`↳ sub-agent`. The end-of-turn summary lists the models used. Every attempt is
appended to `pliny-free-auto-calls.jsonl` with `profile: "balance"`, so
`scripts/summarize-free-auto-log.ts` compares it against the free profiles on
real use, including how often a turn stayed on free models.

The early-stop defences described in
[pliny-free-auto-router.md](pliny-free-auto-router.md#keeping-runs-going-the-completion-guard-the-judge-and-wait)
— the completion guard's pattern rules, the completion judge, and the note
appended to a failed or detached command — apply to a BalanceAuto turn only when
its last call ran on a free model. The paid models do not stop early, and a
nudge would cost a call. The guard judges the main agent's reply, so it looks at
the main agent's last call: a free sub-agent run inside a turn does not make a
paid reply look like a free one. The command note follows whichever agent ran
the command.

When a free model ignores a reminder and stalls again, the rest of the turn moves
to the lead of the `default` route — on BalanceAuto that is Claude Sonnet 5, so
the escalation hands the stuck step to a paid model that does not stall.

The system-prompt addendum about how a turn ends is added only for free
candidates, so the paid models see the prompt unchanged. A reply that collapses
into repetition is cut off and failed over on any model. Every run is logged to
`pliny-free-auto-runs.jsonl` with `profile: "balance"` as well.
