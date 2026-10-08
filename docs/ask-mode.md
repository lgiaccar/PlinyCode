# Ask mode

Ask mode is the third mode of the mode switch, next to Plan and Agent. Agent is the mode the code and settings call "act". In ask mode the agent answers questions about the code and never changes a file. It can still read files, search, fetch web pages and run read-only commands to find the answer.

When an answer involves a code change, the agent shows it in its reply. To have it applied, the user switches to Agent mode.

## Switching

The switch under the prompt box has one segment per mode: **Plan** (yellow), **Agent** (red), **Ask** (green). The selected segment and the outline of the focused prompt box take the mode's color ([ModeSwitch.tsx](../apps/vscode/webview-ui/src/components/chat/chat-textarea/components/ModeSwitch.tsx)). Clicking a segment selects that mode, and the keyboard shortcut cycles through them in that order.

The mode is the same `mode` setting plan and act use ([types.ts](../apps/vscode/src/shared/storage/types.ts)), with the value `"ask"`. On the wire it is `PlanActMode.ASK_MODE`, sent through `togglePlanActModeProto`. Switching mode while a conversation is open rebuilds its session, as for plan and act ([sdk-mode-coordinator.ts](../apps/vscode/src/sdk/sdk-mode-coordinator.ts)). Switching to ask never starts a run by itself.

## No file edits

The rule is enforced in three places in the engine:

- **The tool preset.** The `ask` preset in [presets.ts](../sdk/packages/core/src/extensions/tools/presets.ts) leaves the `editor` and `apply_patch` tools out, so the model is not offered a way to write.
- **The ask-mode guard.** `createAskModeCommandGuardExtension` in [command-guard-extension.ts](../sdk/packages/core/src/extensions/tools/command-guard-extension.ts) is a `beforeTool` hook that the runtime builder registers for ask-mode sessions, sub-agents included. It rejects:
  - every `editor` and `apply_patch` call, markdown files included, in case a host or a sub-agent still exposes one;
  - `run_commands` calls on the file-editing blacklist in [command-guard.ts](../sdk/packages/core/src/extensions/tools/command-guard.ts), the same list plan mode uses.
- **The prompt.** `ASK_MODE_INSTRUCTIONS` in [cline.ts](../sdk/packages/shared/src/prompt/cline.ts) tells the model that it is answering a question, that edits are blocked, and to ask the user to "toggle to Agent mode" when a change should be applied. The chat renders those words, and the former "to Act mode" in older conversations, as a link that switches to Agent mode.

A rejected call comes back to the model as a tool error (`skip`, not `stop`), and the run continues.

One write is allowed: `save_memory`, which adds an entry to the repository's or the user's memory outside the workspace ([memory.md](memory.md)). It is not a file edit of the project, so `/remember` works in ask mode too. It follows the "Edit files" auto-approve toggle.

The command blacklist is a list of common file-editing commands, not a shell interpreter, so it does not catch every possible write (for example a script that writes files). MCP tools are not covered by the guard either; they go through the normal approval.

## Model and routing

Only plan and act have their own model selection. Ask mode runs on the act-mode model and its reasoning settings (`modelSettingsMode` in [types.ts](../apps/vscode/src/shared/storage/types.ts)); choosing a model while in ask mode changes the act-mode model.

For FreeAuto and BalanceAuto, ask mode routes like plan mode: both read and reason, and neither edits. The completion judge, which checks that an act-mode run finished its work, does not run in ask mode.
