# Side questions

A side question is a message the user asks without adding it to the conversation's context. The **Side question** checkbox under the prompt box, next to the mode switch, marks the next message as one. The agent answers it like any other message, but later requests to the model leave out the question, the answer, and every tool call and result made while answering. The chat still shows the exchange.

Use it for a quick question ("what does this function return?") in the middle of a long task, without the answer steering the task or taking up its context window.

## Using it

- The checkbox is enabled once a conversation has started and the agent is idle. A message sent while the agent works joins its turn, and a reply to a question the agent asked answers that question, so neither can be a side question.
- It applies to one message and clears itself after the send. While it is ticked, the focused prompt box has a dashed outline.
- The question shows a **Side question · not in the context** label in the chat, also after the conversation is reopened.
- A side question changes nothing, in any mode. It runs under ask mode's rules: it can read, search, fetch web pages and run read-only commands, but the agent cannot edit files, run file-editing commands, update the task list, or start sub-agents or teammates. A change made there would be one the conversation is never told about.

## How it works

The message is kept in the session's transcript (`messages.json`) with `metadata.offTheRecord: true` on the user message that starts the turn. The transcript is what the chat is rebuilt from, so deleting the turn would also remove it from the chat.

- **Filtering.** `dropOffTheRecordTurns` in [off-the-record.ts](../sdk/packages/core/src/session/off-the-record.ts) removes each marked turn, from its user message up to the next user run (`isUserRunMessage`). The session runtime ([session-runtime-orchestrator.ts](../sdk/packages/core/src/runtime/orchestration/session-runtime-orchestrator.ts)) applies it before every model request and before compaction, keeping the turn being answered, so the side question sees its own tool results.
- **Read-only.** While the newest user run is a side question, the runtime's `beforeTool` hook applies `guardOffTheRecordTool` ([command-guard-extension.ts](../sdk/packages/core/src/extensions/tools/command-guard-extension.ts)). The message goes out in a `<user_input mode="ask">` tag whatever the session's mode is ([turn-execution.ts](../sdk/packages/core/src/runtime/host/local/turn-execution.ts)), so the model knows ask mode's rules apply.
- **Compaction.** Automatic compaction sees the filtered list, so a summary never mentions a side question. Manual `/compact` filters the transcript the same way ([sdk-compaction.ts](../apps/vscode/src/sdk/sdk-compaction.ts)), so the saved compaction state lines up with the list the runtime projects it onto.
- **Per-message context.** A side question does not use up a pending mode-switch notice, and it gets the `<editor_state>` block without the extension recording it as sent ([sdk-session-lifecycle.ts](../apps/vscode/src/sdk/sdk-session-lifecycle.ts), [editor-state.ts](../apps/vscode/src/sdk/context/editor-state.ts)). Both reach the next message on the record instead.
- **Memory.** The guard also rejects `save_memory`, since a memory outlives the conversation. The conversation search index leaves side questions out, `read_conversation` skips them, and memory distillation neither runs after one nor reads one ([memory.md](memory.md)).
- **Routing.** FreeAuto and BalanceAuto route a side question like plan mode, so neither the completion judge nor the reviewer runs on it ([sdk-session-config-builder.ts](../apps/vscode/src/sdk/sdk-session-config-builder.ts)).

On the wire the flag is `AskResponseRequest.off_the_record` ([task.proto](../apps/vscode/proto/cline/task.proto)), carried to the engine as `SendSessionInput.offTheRecord`. `ClineMessage.offTheRecord` marks the chat row.

## Limits

- **Editing the message** with **Edit and restart from here** sends the edited text as a normal message.
- **A bare resume** right after a side question (continuing with an empty message) still counts as part of the side question's turn.
- The first message of a conversation cannot be a side question: there is no context to keep it out of.
