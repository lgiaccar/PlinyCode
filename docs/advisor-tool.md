# The advisor tool: a strong model's advice at a hard step

`ask_advisor` lets the model working on a task put one question to a stronger
model and then carry on itself. A free or cheap model does most steps of a
task well and gets stuck at a few; one short paid answer at that step costs a
few cents, where routing the whole run to the expensive model pays its price
on every routine step.

Code: `apps/vscode/src/sdk/advisor/` (settings, budget rule, tool, session
wiring) and `apps/vscode/src/sdk/message-translator/advisor-rows.ts` (chat
rows). The VS Code settings reader is `apps/vscode/src/hosts/vscode/advisor-settings.ts`.

## What the advisor sees

One request, outside the agent loop, the way the router's classifier and
completion judge are called: a fixed system prompt, then the user's request
for the current run (attached by the extension, from the latest real user
message), the agent's `question`, and its optional `context`. No tools, no
conversation, no repository. The question is cut at 4,000 characters, the
context at 24,000 and the user's request at 4,000; the reply is capped at
1,500 output tokens and the call at 60 seconds. The tool description tells the
model this, and when to call: stuck after two failed attempts at the same
problem, choosing between designs, an unclear root cause, before a risky or
hard-to-undo change. Not for routine steps. No system-prompt section is added.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `plinycode.advisor.use` | `balance` | `balance`: only conversations on `auto-paid-balanced`. `always`: every conversation whose model is not the advisor model itself, FreeAuto and the free models included, which then spend money. `never`: off. |
| `plinycode.advisor.model` | `snps-aws-bedrock/global.anthropic.claude-sonnet-5` | The lead of BalanceAuto's `default` route. Must be a concrete model with a catalog price; a router id is refused. |
| `plinycode.advisor.maxCallsPerConversation` | `5` | Calls past it are refused with an error result. |

They are read on every model call and every tool call, so a change applies to
a running conversation.

## When the tool is offered

The tool is added to every root session's `extraTools`, and a `beforeModel`
hook removes it from the request whenever the conversation is not offered it.
A session's tool list is fixed when it starts, but the setting and the
conversation's model can change under it (a model switch does not rebuild the
session), so the check is per call. The conversation's model is the one the
latest root run started on, taken from the `agentModelFactory` wrapper. A call
that reaches the tool anyway, for example from a stale request, gets the same
check and an error result.

On a router, a call is also refused when the turn's last call ran on the
advisor model itself (BalanceAuto's `default` route leads with it), since there
is nothing stronger to ask.

Sub-agents never see it: core builds a sub-agent's tools from its built-in
tools only, and both the hook and the tool also refuse when the run has a
parent agent.

## Limits and failures

One call at a time per conversation (the tool runs sequentially and holds a
per-conversation in-flight flag). The call count is kept per conversation in
memory and also read back from the advisor answers already in the
conversation, so it survives a session rebuild and an extension restart. A
call is counted when it is sent, so a timed-out call counts.

Every refusal and failure is an error result ending in "Decide on your own",
and the run continues on the working model. The tool is not retried by the
runtime.

## Cost and the conversation budget

An advisor call is a paid call.

- **Budget check.** Before each call the conversation's spend is compared with
  its budget, with the same rule as before a paid model call
  (`checkConversationBudget`): the open task's spend is what the task header
  shows (its chat rows); a task running in the background is read from its
  history record. Unlike the model-call check, it also applies on a free model,
  and a spent budget refuses the call rather than pausing the run: the model
  carries on without advice, and on a paid model the next model call pauses
  the run as usual. A spend that cannot be read refuses the call.
- **Price.** An advisor model with no catalog price is refused, since the
  call's cost could not be shown.
- **Recording.** The tool result carries the call's model, tokens and cost.
  The provider's cost is used when it reports one; tokens without a cost are
  priced from the catalog with the gateway's formula; a stream that reported
  nothing (a timeout, a broken stream) is estimated from text lengths and
  marked estimated. A call that failed after the model started answering
  returns that billed cost with its error instead of throwing. The message
  translator turns the result into a hidden `subagent_usage` row with
  `source: "advisor"`, the row type that already adds sub-agent cost, so the
  task header, the next budget check and the history record all include it.
  The row is rebuilt from the persisted tool result when a conversation is
  reopened, so the cost is not lost. For a task in the background, which has
  no chat rows until reopened, the controller adds the cost to its history
  record directly.

## Chat rows

The call shows as an info row "**Asked the advisor**" with the question and
the size of the context sent. When it returns, a second row shows
"**The advisor's answer**" with the model, tokens and cost, then the advice as
markdown, or "**The advisor could not answer**" / "**The advisor was not
consulted**" with the reason. No proto or webview change was needed.

## Known limitations

- The engine writes its own `totalCost` (root-agent model calls only) to the
  session metadata at the end of a turn. That write can land after the
  extension's `setTaskUsage`, and then the history list leaves out advisor
  (and sub-agent) cost until the next usage event rewrites the total. The task
  header and the budget check read the chat rows and are not affected.
  Sub-agent cost reaches the same `subagent_usage` row type from the
  `spawn_agent` tool result ([agent-tools.md](agent-tools.md), "Sub-agents"),
  and the compaction summarizer's from the compaction notice
  ([context-compaction.md](context-compaction.md)).
- The call count is per conversation; two VS Code windows on the same
  conversation keep separate in-memory counts (the count read back from the
  conversation still applies on the next session start).
- Context-dependent advice is only as good as what the model chose to send.
