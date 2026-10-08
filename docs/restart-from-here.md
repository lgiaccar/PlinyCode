# Restart from here

Clicking one of your earlier messages in a conversation lets you edit it and
**Restart from here**, or **Restart and revert files**. The conversation is
rewound to just before that message and the edited text is sent in its place.
This page explains how the extension finds that point in the history the model
sees, so that nothing from the abandoned turns reaches it.

The code is `SdkController.editMessageAndRegenerate` (`apps/vscode/src/sdk/`),
with the mapping in `sdk-user-message-mapping.ts` (`planEditRestart`) and the
row bookkeeping in `sdk-checkpoints.ts` (`describeEditedRow`).

## What happens

1. The running turn, if any, is cancelled and the conversation's saved history
   (`<sessionId>.messages.json`) is read.
2. The edited chat row is mapped to a place in that history (below).
3. A new session starts from the history before that place, and the edited
   text is sent as the next message. The old session is deleted.

Everything the abandoned turns built up in memory goes with the old session:
compaction state (the saved history is never compacted, so a summary that
covered later turns cannot come back), loop and mistake counters, queued
notices, the router's per-turn state and errors VS Code reports late for files
those turns edited.

## Mapping a chat row to the history

The chat and the saved history do not line up one to one, so the row is
mapped, not counted:

- **Your answers to the agent's questions, and the feedback you give when you
  reject a tool, are tool results** in the history, not user messages. Their
  chat rows carry `answersTool`, and they are left out when prompt rows are
  counted. Before this, every answer moved the restart point one message too
  far, so the model still saw the original message and its reply.
- **A prompt row** maps to the Nth user message with a visible row (hidden
  continuation prompts, reminders and hook context are skipped), checked
  against the row's text. When the Nth message shows different text, for
  example because a queued prompt never reached the agent, the nearest message
  with the row's text wins.
- **An answer row** maps to the tool result that holds the answer. The new
  conversation keeps the question (or the rejected call), takes your answer
  out of its result ("The user will answer in their next message.") and sends
  the edited answer as the next message.

## Checkpoints and reverting files

Checkpoint runs are numbered by core's `countUserRunMessages`, the same counter
the checkpoint hook uses when it takes them. Tool results, reminders and other
runtime-injected messages start no run. (The extension used to count every
message stored with the user role, tool results included, so "Restart and
revert files" restored a checkpoint far later than the edited message, often
the newest one.)

The new conversation carries over only the checkpoints of the runs before the
edited message; the regenerated run takes its own, so "View changes" and the
reviewer never compare against a snapshot from the abandoned turns. The
carried snapshots get refs under the new session before the old one is
deleted, so git keeps them.

Files can be reverted only from a prompt row, not from an answer row.

## Checking what the model sees

**PlinyCode: Show Last Model Request (debug)** in the Command Palette opens the
last request the active conversation sent to its model as JSON: the system
prompt, the messages after compaction (reminders and hidden notices included)
and the tools. It is the request as the agent built it, before provider-specific
conversion, and it is kept in memory only, for the eight most recent
conversations since the window opened (`last-model-request.ts`).
