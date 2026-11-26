# Suggested next prompts

PlinyCode Desktop and the VS Code / Cursor extension can suggest a useful next prompt after a completed turn.
The suggestion appears as gray placeholder text only when the composer is empty.

- Press **Tab** to copy the suggestion into the draft. It remains editable; **Enter** sends it.
- Press **Esc**, type your own prompt, or switch chats to dismiss it. Modified Tab keys retain their usual behavior.
- Suggestions do not replace a draft, attachments or quoted context. They do not appear during a running,
  cancelled or failed turn. A late response is discarded when you edit or leave the chat.
- No suggestion is shown when the model sees no useful next step, credentials are unavailable, or the request fails.

Suggestions use a separate, tool-free request through Pliny, with bounded recent user and assistant text
(up to six messages, 2,000 characters each). Tool results and attached file contents are not added to this request.
Desktop uses the same free model as Improve prompt; the extension uses the router's `commit` utility model.
Requests have a 12-second deadline and a bounded in-memory cache per completed turn. The suggestion itself is
not stored in chat history or sent to the agent until you accept and send it. It grants no tool permissions.

This differs from [Improve prompt](improve-prompt.md), which rewrites a draft you have already typed.
