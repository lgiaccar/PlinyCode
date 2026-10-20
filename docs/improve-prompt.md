# Improve prompt

The wand button under the prompt box, left of the "Side question" box, rewrites the draft prompt so it is clearer. It fixes spelling and grammar, makes the request explicit, and splits run-on requests into short sentences. A small free Pliny model does the rewrite, so it costs nothing and does not count against the conversation budget.

The rewrite replaces the draft. A "Prompt improved. Undo" line then appears under the prompt box; Undo puts the original back. The line goes away as soon as the draft is edited or sent. A failure, such as a gateway error, an empty reply, or a draft that is too long, is shown on the same line and leaves the draft untouched.

## What the model is told

The rewrite is one request with no tools and no conversation context: the model sees only the draft and the mode it will be sent in ([prompt-improver.ts](../apps/vscode/src/sdk/prompt-improver.ts)). Its instructions:

- **Edit the draft, don't carry it out.** The draft comes wrapped in `<draft>` tags as text to edit. A draft that asks for a plan or an answer gets a clearer request back, not the plan or the answer.
- **Keep the meaning.** Add no requirements, files or facts, keep the draft's language, and stay about as long as the draft.
- **Favour markdown.** A draft with several parts, steps or requirements gets short headings, lists, **bold** key terms and fenced code blocks; a one-line request gets no headings. Markdown the draft already has is never removed or flattened.
- **Keep markup exactly as written:** `@mentions`, `/slash` commands, file paths, URLs, identifiers and code.

The reply is cleaned before it is used:

- a code fence around the whole reply (code blocks inside it stay), echoed draft tags, wrapping quotes and a "Here is the improved prompt:" preamble are removed;
- an `@mention` the model put in backticks is freed again, since a mention in backticks is not resolved.

Some replies are rejected and leave the draft unchanged:

- a reply more than three times as long as the draft (the model answered instead of editing);
- an empty reply;
- a draft over 8,000 characters (this happens before any call).

## Model and timing

The model is the router rules' `commit` utility model: `qwen3-next-80b-a3b-instruct` unless a rules file names another ([pliny-free-auto-router.md](pliny-free-auto-router.md)). It is an instruct model with no reasoning, and it answered in 0.4-1.8 s in live tests. The call goes through `completeWithUtilityModel` ([memory-model.ts](../apps/vscode/src/sdk/memory/memory-model.ts)), the helper memory distillation and CI triage use, and is aborted after 20 seconds.

The draft may change while the request is out. When the rewrite arrives, the draft is only replaced if it is still exactly what was sent ([useImprovePrompt.ts](../apps/vscode/webview-ui/src/components/chat/chat-textarea/hooks/useImprovePrompt.ts)); otherwise the user's edits win and the rewrite is dropped.

The webview calls `TaskService.improvePrompt` ([improvePrompt.ts](../apps/vscode/src/core/controller/task/improvePrompt.ts)). It never fails: the reason the prompt could not be improved comes back in its `error` field.
