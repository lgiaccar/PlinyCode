# Suggested next prompts

PlinyCode Desktop and the VS Code / Cursor extension suggest useful next prompts after a completed turn.
Up to three choices appear one at a time as gray placeholder text when the composer is empty.

- Press **Left/Right** to cycle through the choices; the hint shows your position. Cycling makes no model requests.
- Press **Tab** to copy the selected suggestion into the draft. It remains editable; **Enter** sends it.
- Press **Esc**, type your own prompt, or switch chats to dismiss it. Modified arrow/Tab keys and IME input retain their usual behavior.
- The prompt wand shows **Suggest prompt** when the composer is empty and **Generate alternatives** when choices are visible.
  Click it to request fresh suggestions, including after dismissing them. With a draft, it remains **Improve prompt**.
- **Generating…**, **No useful follow-up found.**, and **Couldn’t generate—retry.** distinguish a pending request,
  a deliberate lack of useful next steps, and a failure. The button is disabled while generating; it can retry afterward.
- Suggestions never replace a draft, attachments or quoted context. They do not appear during a running,
  cancelled or failed turn. Late responses are discarded when you edit or leave the chat.

Suggestions use one separate, tool-free request through Pliny for all choices, with bounded recent user and
assistant text (up to six messages, 2,000 characters each). Tool results and attached file contents are excluded.
Desktop uses the same free model as Improve prompt; the extension uses the router's `commit` utility model.
Requests have a 12-second deadline and a bounded in-memory cache per completed turn. Successful and deliberately
empty results are cached; failures are not. Clicking the wand bypasses that cache and asks for fresh alternatives.
The model may return fewer than three choices, including none, when no useful follow-up exists.

Suggestions are not stored in chat history or sent to the agent until you accept and send one. They grant no tool permissions.
