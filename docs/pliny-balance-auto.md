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
| `plan-and-reasoning` | tier `reason`, or any plan-mode turn | Claude Sonnet 4.6 high-thinking preset, Claude Sonnet 5, GPT-5.2 (reasoning on, high) |
| `ask-reasoning` | ask mode with a why/explain/review question | Claude Sonnet 5, free kimi-k2.6, Claude Sonnet 4.6 (reasoning on, medium) |
| `coding` | tier `code`, or act mode with a coding prompt | free kimi-k2.6, free qwen3-coder, then Claude Sonnet 5 |
| `quick` | tier `quick`, or a short question | free kimi-k2.6, free nemotron super, then Haiku 4.5 |
| `default` | anything else | Claude Sonnet 5, free kimi-k2.6, Claude Sonnet 4.6 |

Sonnet is where it earns its price and nowhere else. In the first week of use
the coding route alone put about seventy percent of BalanceAuto's calls on
Sonnet, and most of them were routine edits the free coder does as well. The
coding route now leads with the free models and reaches Sonnet 5 three ways:
as the failover when both free candidates are down, as the catch-all
`default` route for turns the classifier could not place, and through the
completion guard's escalation, which moves a free model that stalled twice in
a row, or three times in the run, to the `default` route's lead, Sonnet 5, for the rest of the turn. Reasoning
turns go straight to the Sonnet 4.6 thinking preset. The classifier guidance
in the rules file says the same, so it picks `reason` only where a strong
model changes the outcome.

**A verdict whose route refuses the request falls back by tier, not to the
catch-all.** The `quick` route admits requests up to 30k tokens; a `quick`
verdict on a longer conversation ("please also update the PR message", 41k
tokens) used to fall through to `default`, Sonnet 5, for the whole turn: 49
such calls in a week. It now goes to `coding`. A `huge` verdict below the
huge route's 180k bound (every one of the 164 seen, median 70k) goes to
`coding` in act mode and `plan-and-reasoning` in plan and ask mode. The classifier
no longer offers `huge` at all: the router already routes by size, and the
classifier cannot know the context better than the router does. The call log
shows a fallback as the tier with another route (`tier: quick, route:
coding`), and the summary script counts them under "Classifier verdicts that
left their route".

**What the classifier and the keyword routes read.** Only what the user typed:
the `<editor_state>` block (active file, open tabs) and `<mode_notice>` are
stripped first, and runtime reminders, hook context and compaction summaries
are skipped, both as the "latest request" and in the classifier's digest of
earlier messages. An open tab named `app.ts` used to match the coding regex,
the open-tabs list pushed every prompt past the quick route's 300-character
bound, and a `[SYSTEM]` reminder was handed to the classifier as the request.
The classifier's instructions also spell out that chores (creating or
updating a PR, committing and pushing, fixing a CI failure, waiting for a
build, writing notes to a file, `[CI WATCHER]` messages) are `code`: in the
same week, `reason` verdicts put 124 calls of a turn that was polling a build
on the Sonnet thinking preset.

The pool leads with the paid models, so a turn whose free candidates all fail
still lands on a strong one. Health benching, context-window checks, sticky
choice and failover all behave as for FreeAuto.

Two things the router cannot do for hosted models:

- **Thinking.** Only self-hosted models have a measured reasoning switch, so
  `effort` leaves hosted models at their default. Where thinking is wanted,
  route to a preset such as `aws-bedrock-vmodels/claude-4-6-sonnet-high-thinking`,
  as the reasoning route does.
- **Context beyond 200k.** Hosted entries take their window from the Pliny
  Model Catalog page: Claude Sonnet 4.6 1M, GPT-5.2 272k (the input share of
  its 400k), Gemini 3.5 / 2.5 Flash 1M. Entries the page does not list (Claude
  Sonnet 5, the Sonnet 4.6 thinking presets) keep the 200k hosted default, and a
  request beyond roughly 118k estimated tokens (window minus the output reserve)
  skips them for a model with room. The conversation itself compacts against
  BalanceAuto's own 128k input budget (at about 115k estimated tokens), so a
  run stays within reach of those 200k-default models and each paid call is
  billed on a smaller input.

Utility jobs (classifier, compaction summaries, commit messages) stay on free
models by default. The rules file may point any of them at a paid model.

Images no longer pull a turn onto the paid models. A call with an image is
routed like any other: the paid Claude candidates get the image itself, and a
free one gets it as a description made once per image by Claude Haiku 4.5
(`plinycode.router.images`, see "Images" in
[pliny-free-auto-router.md](pliny-free-auto-router.md)). Paid models are always
allowed for this on BalanceAuto, whatever the unlock toggle says.

## The rules file

Global: `<data dir>/pliny-balance-auto.md`, created on first activation and
opened with **PlinyCode: Open Routing Rules (FreeAuto / BalanceAuto)** from the
command palette. Workspace override: `<workspace>/.cline/pliny-balance-auto.md`.
The FreeAuto profiles keep their own files, and a project's
`.cline/pliny-free-auto.md` never applies to BalanceAuto, so free-only
overrides cannot displace its paid routes. **Settings → Router → BalanceAuto**
sets its model order (free and paid models) and the other knobs without
editing the file; its values override the file's
([router-settings.md](router-settings.md)).

The file has the same shape as the FreeAuto one. The differences:

- Any concrete Pliny id is accepted in `pool`, `use` and `utility`; a virtual
  router id is still ignored. The FreeAuto files keep rejecting paid ids.
- The prose under "Guidance for the classifier" tells the classifier which
  tiers are free and which are paid, so it can prefer `quick` for anything a
  small model would finish.

## Watching it work

Chat rows read `BalanceAuto → **Claude Sonnet 5** (call 1 · route: coding ·
classifier: code · ~12k tok)`, naming each model by its catalog name; sub-agent rows are prefixed with
`↳ sub-agent`. Each sub-agent run keeps its own call log, sticky model and failover budget under a key of
its own (`<session>:sub:<n>`), found again by the engine's agent id, so parallel sub-agents never share
one and a failure benches the model of the run that failed. The end-of-turn summary lists the models used. Every attempt is
appended to `pliny-free-auto-calls.jsonl` with `profile: "balance"`, so
`scripts/summarize-free-auto-log.ts` compares it against the free profiles on
real use, including how often a turn stayed on free models. Each line carries
the call's tokens and `costUsd`, and each run line the turn's totals with its
`paidCalls` and `paidCostUsd`, so the script's "BalanceAuto: paid vs free
calls" table and its cost per successful turn show what the paid routes cost
next to the free ones (see
[Tokens and cost](pliny-free-auto-router.md#tokens-and-cost)).

The early-stop defences described in
[pliny-free-auto-router.md](pliny-free-auto-router.md#keeping-runs-going-the-completion-guard-the-judge-and-wait)
— the completion guard's pattern rules, the completion judge, and the note
appended to a failed or detached command — apply to a BalanceAuto turn only when
its last call ran on a free model. The paid models do not stop early, and a
nudge would cost a call. The guard judges the main agent's reply, so it looks at
the main agent's last call: a free sub-agent run inside a turn does not make a
paid reply look like a free one. The command note follows whichever agent ran
the command.

When a free model ignores a reminder and stalls again, or keeps stalling between
steps (three stalls in the run), the rest of the turn moves to another model.
The first such escalation in a turn goes to the next free model of the turn's
route (then of the `coding` route, then of the pool): the stall rules fire
most on Kimi writing its thinking as the reply, and handing the last one or
two calls of a 100k-token turn to Sonnet 5 wrote the whole prefix into its
cache for a reply of a hundred tokens. A second escalation in the same turn
goes to the lead of the `default` route — on BalanceAuto that is Claude Sonnet
5, so a step two free models could not take is handed to a paid model that
does not stall. The run log's `escalatedTo` names the model.

**Paid-call cap.** The model chosen at the start of a turn is kept for all of
it (`sticky`), so one `reason` verdict puts every call of the turn on paid
Claude: a turn spent 124 calls on the Sonnet thinking preset watching a build.
`health.maxPaidCallsPerTurn` (default 20, `0` turns it off) caps that: once a
turn has made that many calls on paid models, the rest of it runs on the
first free model of the `coding` route, the chat says so (`⚠ 20 paid calls
this turn (health.maxPaidCallsPerTurn: 20) · ↪ switching to **Kimi K2.6**`),
and the run log line carries `paidCapHit: true`. It fires once per turn; a
later failover from the free model to a paid backup is left alone. Only the
main agent's calls count, and only calls on hosted models, so the classifier,
the judge and image descriptions do not.

Failing commands escalate too. When six commands have failed in one turn (builds that do not compile, test runs that do not pass; a command that passes in between does not reset the count), the rest of the turn moves to the same `default` lead and the chat says so (`⚠ 6 commands have failed this turn`). It happens once per turn, and only while a free model is answering. The count is `failedCommands` in the run log. It is the case the stall rules miss: a model that keeps acting, and keeps failing, never stalls.

The system-prompt addendum about how a turn ends is added only for free
candidates, so the paid models see the prompt unchanged. A reply that collapses
into repetition is cut off and failed over on any model. Every run is logged to
`pliny-free-auto-runs.jsonl` with `profile: "balance"` as well.
