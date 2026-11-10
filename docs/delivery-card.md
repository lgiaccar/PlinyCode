# Delivery card

The latest completed Agent response includes **Delivery**, below its change summary. Changes use the existing
checkpoint diff: enable checkpoints to inspect changed files and line counts.

The card reads paired tool calls and results from this conversation's saved transcript. It groups recognized
test/check, pull-request, CI and release commands. Expand an entry to inspect the actual input and output.
Assistant prose is never evidence, and a tool returning without an error does not establish that tests passed
or a release was published. Custom command names may not be recognized; missing evidence says **Not confirmed**.
The most recent 40 matching results are retained in the card; long inputs and outputs have explicit preview limits.

A read-only remote lookup uses the conversation's folder and branch, including its worktree when present.
It shows the latest branch PR (including merged or closed PRs), its remote head, reported checks and the check time.
If the head or PR state changes during the lookup, the card asks you to refresh. In a shared checkout this is the
folder's current branch; switching that branch changes the lookup. Reported checks are not a merge approval and
do not prove every required workflow ran. **Refresh evidence** repeats the lookup; it does not queue CI or merge.

**Verify delivery with agent** sends a follow-up in the same conversation to inspect current changes, checks,
PR and publication evidence. It uses the normal mode and approval rules. A recorded publish command alone is
not proof of a public asset: publication remains unconfirmed until inspected.
