# Rules files

Which instruction files reach the model, how much of each, and in what order. The code is in [user-instruction-config-loader.ts](../sdk/packages/core/src/extensions/config/user-instruction-config-loader.ts) (discovery), [nested-guides.ts](../sdk/packages/core/src/extensions/config/nested-guides.ts) (per-directory agent guides) and [rules.ts](../sdk/packages/core/src/runtime/safety/rules.ts) (the `# Rules` section of the system prompt).

## What is read

- The workspace's `AGENTS.md`, `.clinerules/` and `.cline/rules/`.
- The running editor's own rule folders: in VS Code, `.github/copilot-instructions.md` and `.github/instructions/`; in Cursor, `.cursor/rules/`.
- `~/.agents/AGENTS.md` and the global rules folder.
- **Agent guides below the root**: every `AGENTS.md` and `CLAUDE.md` in a sub-directory, up to three levels deep, and a `CLAUDE.md` at the root. Dependency, build and hidden folders (`node_modules`, `dist`, `.git`, …) are skipped, at most 30 guides are taken (shallowest first), and they are found when the workspace's rules are first loaded: a guide added later shows up after a reload.

The Rules panel's toggles apply to all of them. Rules are re-read on every run, so editing one changes the next request.

The panel has Rules, Skills, Agents and Hooks tabs ([agent-tools.md](agent-tools.md) covers the Agents tab). While it is open, the extension watches the rules, skills, hooks and agents folders of the workspace and of the global locations (`customization-watcher.ts`), and the open tab reloads when a file there changes; nothing is rescanned while the panel is closed.

## Inlined or listed

The section is resent with every request, so it has a budget:

- An always-on rule is inlined, cut at 12,000 characters (`MAX_RULE_CHARS`) with a note pointing at the file; all inlined rules together get 40,000 (`MAX_RULES_TOTAL_CHARS`). What does not fit is listed by path.
- A scoped rule (file globs, Copilot's `applyTo`, Cursor's description-only rules) is listed by name, scope and path, and the model reads it with `read_files` when its scope applies.
- **Agent guides below the root are always listed, never inlined.** A nested `AGENTS.md` is scoped to its own folder (`apps/vscode/AGENTS.md` applies to `apps/vscode/**`) unless it sets a scope in its frontmatter; a root `CLAUDE.md` is listed as "read it when AGENTS.md and the rules above do not answer something", since it usually repeats `AGENTS.md`.

The model sees, for this repository:

```
## Rules to read when they apply
- **apps/vscode/AGENTS.md** (Applies only when working with files matching: `apps/vscode/**`): `…/apps/vscode/AGENTS.md`
- **sdk/AGENTS.md** (Applies only when working with files matching: `sdk/**`): `…/sdk/AGENTS.md`
```

## Order

Inlined rules fill the budget in this order: the workspace's `AGENTS.md`, the global `AGENTS.md`, then the rest by name. By name alone, a rule called `a-style.md` came before `AGENTS.md` and could push it out of the budget.

## Slash commands

A workflow typed as a slash command pastes its body into the message, cut at 24,000 characters ([agent-tools.md](agent-tools.md), "Slash commands that paste instructions"). Skills are loaded through the `skills` tool instead.

## Hooks

Hook files are scripts that run when an agent event fires. The engine runs them ([hook-file-hooks.ts](../sdk/packages/core/src/hooks/hook-file-hooks.ts)); the extension decides which may run and shows each run in the chat. The Rules panel's **Hooks** tab lists them, creates one from a template, and opens, deletes or switches each one on or off. The tab is hidden while **Settings → Features → Hooks** (the `hooksEnabled` setting) is off, and then no hook file runs.

### Which files

A hook file is named after its event, with an optional extension that picks the interpreter: none or `.sh`/`.bash`/`.zsh` (bash, or the file's shebang), `.js`/`.mjs`/`.cjs` (node), `.ts` (bun), `.py` (`py -3` on Windows, `python3` elsewhere) and `.ps1` (PowerShell). They are read from four directories ([hook-file-config.ts](../sdk/packages/core/src/hooks/hook-file-config.ts)):

- global: `Documents/Cline/Hooks` and `~/.cline/hooks`;
- the workspace: `.clinerules/hooks` and `.cline/hooks`.

Every matching file runs, so `PreToolUse.ps1` and `PreToolUse.js` in the same directory both run. A session finds its hook files when it starts: a file added later runs from the next conversation, or once a mode switch rebuilds the session.

| File | Runs | Waited for |
| --- | --- | --- |
| `TaskStart` | before each run of the agent | no |
| `UserPromptSubmit` | when a user message is added | no |
| `PreToolUse` | before each tool call | yes; can cancel the call or add context |
| `PostToolUse` | after each tool call | yes; can stop the run or add context |
| `TaskComplete` | when a run completes | no |
| `TaskCancel` | when a run is cancelled | no |
| `SessionShutdown` | after `TaskCancel`, when a run is cancelled | no |
| `TaskError` | when a run ends on an error | no |
| `TaskResume` | only with `CLINE_HOOK_AGENT_RESUME=1` in the environment, which PlinyCode does not set, so not yet | no |

A hook gets the event as JSON on stdin and may print a JSON object: `{"cancel": true, "errorMessage": "…"}` cancels, `{"contextModification": "…"}` adds a `<hook_context>` block to the conversation. Only `PreToolUse` and `PostToolUse` are waited for (up to two minutes each), so only they can cancel or add context; the other hooks run alongside the agent. The Cline-era runner the extension used before this also waited for `TaskStart` and `UserPromptSubmit` and let them cancel a run, and it never ran `TaskError` or `SessionShutdown`.

### Toggles

Each file's switch is stored by the extension, not in the file: global hooks in the `globalHooksToggles` setting, workspace hooks in the `localHooksToggles` workspace state, keyed by path. The engine asks the extension before every run (`localRuntime.hookFilter`), so switching a file off, or turning **Hooks** off, applies to the next hook run of a live session, on every platform. Turning **Hooks** back on applies to sessions started afterwards.

- A hook created from the tab starts switched off, so the template does not run before it has been edited.
- A file with no recorded switch runs, with one exception kept from the Cline-era runner: on macOS and Linux, an extensionless file without the executable bit (that runner's "off", set with `chmod -x`) stays off until it is switched on in the tab. Nothing changes file modes any more.

### Status rows

Each run shows as a `hook_status` row with the hook's name, the tool for `PreToolUse` and `PostToolUse`, and its status: running, then completed, failed or cancelled. The engine reports each run (`localRuntime.onHookStatus`) and [hook-status-rows.ts](../apps/vscode/src/sdk/hook-status-rows.ts) turns the report into the row, giving the final status the running row's id so that it replaces the row. A background conversation's rows are dropped, and a failure is also logged with its reason. The wiring is in [vscode-session-host.ts](../apps/vscode/src/sdk/vscode-session-host.ts).
