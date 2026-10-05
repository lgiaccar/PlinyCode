# Plan mode

In plan mode the agent explores the code and writes its plan as markdown files, which the user can edit before running them. When the plan is ready, an **Execute plan** button switches to act mode (labelled Agent in the mode switch) and asks the agent to carry it out.

Ask mode, which answers questions and writes nothing at all, is described in [ask-mode.md](ask-mode.md).

## Plan files

The agent writes plans under `plans/<slug>/`, relative to the workspace root:

- `plans/<slug>/PLAN.md` is the root file and is written first. It holds the goal, the relevant context, the ordered steps, how to verify the result, and links to any sub-files.
- A large or independent part of the plan can go in its own file next to the root, such as `plans/<slug>/01-backend.md`, linked from `PLAN.md`. A small plan needs only `PLAN.md`.
- When the user gives feedback, the agent updates the existing files instead of starting a new folder.

These rules live in `PLAN_MODE_INSTRUCTIONS_BASE` in [sdk/packages/shared/src/prompt/cline.ts](../sdk/packages/shared/src/prompt/cline.ts).

The model that executes a plan may not be the one that wrote it (see [Choosing the model that executes](#choosing-the-model-that-executes)). `PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH`, the variant the extension uses, therefore also asks for a plan that stands on its own: written for an executor that has not seen the conversation and may be a weaker model, with exact file paths, the steps in order, the command that verifies each step, the decisions already made with their reasons, and what the planner found while exploring. It is one sentence, because the plan-mode prompt is sent with every call.

## Markdown-only writes

Plan mode can write markdown files and nothing else. The rule is enforced in two places in `@plinycode/core`:

- **The tool preset.** The plan preset in [presets.ts](../sdk/packages/core/src/extensions/tools/presets.ts) turns the `editor` tool on. `apply_patch` stays off.
- **The plan-mode guard.** [command-guard-extension.ts](../sdk/packages/core/src/extensions/tools/command-guard-extension.ts) is a `beforeTool` hook that the runtime builder registers for plan-mode sessions, sub-agents included. It rejects these calls before they reach approval:
  - `editor` calls whose `path` doesn't end in `.md` or `.markdown`;
  - `apply_patch` patches that touch any non-markdown file, or that have no file header the guard can parse;
  - `run_commands` calls on the file-editing blacklist in [command-guard.ts](../sdk/packages/core/src/extensions/tools/command-guard.ts). Shell redirects to `.md` files are still blocked, so the editor is the only way to write.

A rejected call comes back to the model as a tool error (`skip`, not `stop`), and the run continues. Allowed markdown writes go through the normal edit approval and the "Edit files" auto-approve toggle, the same as edits in act mode.

## The Execute plan button

At the end of a plan-mode turn, the extension relabels the last text row as `plan_completion_result` ([live-events.ts](../apps/vscode/src/sdk/message-translator/live-events.ts)). `ChatRow` renders that row with `PlanCompletionOutputRow`.

To find the root file, [planFiles.ts](../apps/vscode/webview-ui/src/components/chat/chat-view/utils/planFiles.ts) looks at the editor tool rows (`newFileCreated` / `editedExistingFile`) that wrote markdown files between the previous act-mode `completion_result` and the plan row:

- the most recently written `PLAN.md` is the root;
- if there is none, the first markdown file written is the root;
- if no markdown file was written, there is no root, because the reply was a question and not a plan.

The row shows a footer with a link that opens the root file and an **Execute plan** button. The footer only appears when all of these are true:

- a root file was found;
- the extension is still in plan mode;
- the row is complete;
- no newer result or user message follows the row.

Clicking the button calls `togglePlanActModeProto` with `mode: ACT`, `chatContent.message` set to `execute the plan in <root file>`, and `executePlanWith` set to the model choice described below. Because a plan was just presented, `SdkModeCoordinator.togglePlanActMode` ([sdk-mode-coordinator.ts](../apps/vscode/src/sdk/sdk-mode-coordinator.ts)) rebuilds the session in act mode, shows the message as the user's, and sends it as the first act-mode prompt. Act mode reads the files from disk, so edits the user made after the plan finished are included.

## Choosing the model that executes

The plan is a set of files, so a strong model can write it and a cheaper or free one can carry it out. **Execute plan** is a split button ([ExecutePlanButton.tsx](../apps/vscode/webview-ui/src/components/chat/ExecutePlanButton.tsx)):

- The main part always names the model it will run on, for example **Execute plan · FreeAuto**, so the cost of a click is never a surprise.
- The arrow opens **Execute with…**, which lists the models the plan can run on. Picking one executes the plan on it and makes it the main part's default from then on.

| Choice (`plinycode.plan.executeWith`) | Runs the plan on                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| `actModel` (default)                  | the model act mode is set to; no model changes                                 |
| `freeAuto`                            | FreeAuto (`pliny/auto-free`)                                                   |
| `balanceAuto`                         | BalanceAuto (`pliny/auto-paid-balanced`)                                       |
| `planModel`                           | the model plan mode is set to, which wrote the plan                            |

The menu shows one row per model: a choice that would run the same model as a row above it is left out, so with FreeAuto as the act-mode model there is no second FreeAuto row. BalanceAuto can spend money, so like the model picker the menu offers it only when "Unlock Pliny paid models" is on.

The last choice is stored in the `plinycode.plan.executeWith` VS Code setting ([plan-settings.ts](../apps/vscode/src/hosts/vscode/plan-settings.ts)), which can also be edited by hand.

When the request carries a choice, `togglePlanActModeProto` calls `preparePlanExecution` ([plan-execution.ts](../apps/vscode/src/sdk/plan-execution.ts)) before it switches the mode:

1. It works out the model the choice names. If act mode is not already set to it, it commits that model as act mode's selection, the same way the model picker does. The session that the mode switch builds next reads it.
2. If that model differs from plan mode's and "Use different models for Plan and Agent modes" is off, it turns the setting on first. With the setting off a commit writes both modes, which would replace the planner's model as well.
3. It saves the choice in the setting.

If the model cannot be committed, the request fails and the plan is not executed.

Things to know:

- **The model switch is not per conversation.** Model selection is global, so act mode stays on the chosen model after the plan has run, in every conversation, until another model is picked.
- **It builds on an existing setting.** With "Use different models for Plan and Agent modes" on, each mode has always kept its own model, and the switch to act mode that Execute plan makes already moved to act mode's model. The button shows which model that is and lets the user change it where the plan is run.
- **Execution stays in the same conversation.** The executor starts with the planning conversation as its context. A free model can have a much smaller context window than a paid planner, so a long planning conversation may have to be compacted before the executor can work. This is the reason the plan has to stand on its own.
- **The conversation budget still applies.** The budget is checked before every model call against the model the active mode is set to at that moment (`SdkController.checkSpendingLimit`). A paid executor is held to the conversation's budget from its first call, including what a paid planner already spent. A free executor is not limited, like any free model.
