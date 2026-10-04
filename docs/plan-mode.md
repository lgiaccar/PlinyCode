# Plan mode

In plan mode the agent explores the code and writes its plan as markdown files, which the user can edit before running them. When the plan is ready, an **Execute plan** button switches to act mode and asks the agent to carry it out.

Ask mode, which answers questions and writes nothing at all, is described in [ask-mode.md](ask-mode.md).

## Plan files

The agent writes plans under `plans/<slug>/`, relative to the workspace root:

- `plans/<slug>/PLAN.md` is the root file and is written first. It holds the goal, the relevant context, the ordered steps, how to verify the result, and links to any sub-files.
- A large or independent part of the plan can go in its own file next to the root, such as `plans/<slug>/01-backend.md`, linked from `PLAN.md`. A small plan needs only `PLAN.md`.
- When the user gives feedback, the agent updates the existing files instead of starting a new folder.

These rules live in `PLAN_MODE_INSTRUCTIONS_BASE` in [sdk/packages/shared/src/prompt/cline.ts](../sdk/packages/shared/src/prompt/cline.ts).

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

Clicking the button calls `togglePlanActModeProto` with `mode: ACT` and `chatContent.message` set to `execute the plan in <root file>`. Because a plan was just presented, `SdkModeCoordinator.togglePlanActMode` ([sdk-mode-coordinator.ts](../apps/vscode/src/sdk/sdk-mode-coordinator.ts)) rebuilds the session in act mode, shows the message as the user's, and sends it as the first act-mode prompt. Act mode reads the files from disk, so edits the user made after the plan finished are included.
