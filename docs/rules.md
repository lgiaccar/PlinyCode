# Rules files

Which instruction files reach the model, how much of each, and in what order. The code is in [user-instruction-config-loader.ts](../sdk/packages/core/src/extensions/config/user-instruction-config-loader.ts) (discovery), [nested-guides.ts](../sdk/packages/core/src/extensions/config/nested-guides.ts) (per-directory agent guides) and [rules.ts](../sdk/packages/core/src/runtime/safety/rules.ts) (the `# Rules` section of the system prompt).

## What is read

- The workspace's `AGENTS.md`, `.clinerules/` and `.cline/rules/`.
- The running editor's own rule folders: in VS Code, `.github/copilot-instructions.md` and `.github/instructions/`; in Cursor, `.cursor/rules/`.
- `~/.agents/AGENTS.md` and the global rules folder.
- **Agent guides below the root**: every `AGENTS.md` and `CLAUDE.md` in a sub-directory, up to three levels deep, and a `CLAUDE.md` at the root. Dependency, build and hidden folders (`node_modules`, `dist`, `.git`, …) are skipped, at most 30 guides are taken (shallowest first), and they are found when the workspace's rules are first loaded: a guide added later shows up after a reload.

The Rules panel's toggles apply to all of them. Rules are re-read on every run, so editing one changes the next request.

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
