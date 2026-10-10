/**
 * Built-in slash commands that expand into a prompt on the SDK runtime.
 *
 * These are appended to the workflow/skill commands the user-instruction
 * service discovers on disk, so the existing expandSlashCommands machinery
 * handles the token matching and replacement.
 *
 * `/deep-planning` is a trimmed port of the legacy extension's prompt
 * (core/prompts/commands/deep-planning): the shell-specific research-command
 * examples are dropped, and legacy's final step — which created an
 * implementation task via the `new_task` tool, unavailable on the SDK
 * runtime — instead has the agent present the plan and wait for explicit
 * user confirmation.
 */

import type { AvailableRuntimeCommand } from "@plinycode/core"

const DEEP_PLANNING_INSTRUCTIONS = `<explicit_instructions type="deep-planning">
Your task is to create a comprehensive implementation plan before writing any code. This process has four distinct steps that must be completed in order.

Your behavior should be methodical and thorough - take time to understand the codebase completely before making any recommendations. The quality of your investigation directly impacts the success of the implementation.

## STEP 1: Silent Investigation

<important>
Do not write any code until explicitly instructed by the user to proceed with coding.
You must thoroughly understand the existing codebase before proposing any changes.
Perform your research without commentary or narration. Execute commands and read files without explaining what you're about to do. Only speak up if you have specific questions for the user.
</important>

Use your file reading and search tools, plus terminal commands where helpful, to understand the project: its structure and languages, existing class/function definitions, import patterns and dependencies, dependency manifests, and existing TODO/FIXME markers. Tailor your exploration to the codebase and keep command output concise (for example, exclude dependency folders such as node_modules, venv, or vendor).

## STEP 2: Discussion and Questions

Ask the user brief, targeted questions that will influence your implementation plan. Keep your questions concise and conversational. Ask only essential questions needed to create an accurate plan.

**Ask questions only when necessary for:**
- Clarifying ambiguous requirements or specifications
- Choosing between multiple equally valid implementation approaches
- Confirming assumptions about existing system behavior or constraints
- Understanding preferences for specific technical decisions that will affect the implementation

Your questions should be direct and specific. Avoid long explanations or multiple questions in one response.

## STEP 3: Create Implementation Plan Document

Create a structured markdown document containing your complete implementation plan. Save it as implementation_plan.md, structured as follows:


# Implementation Plan

[Overview]
Single sentence describing the overall goal, followed by paragraphs outlining scope, context, and high-level approach.

[Types]
Type system changes: type definitions, interfaces, enums, or data structures with complete specifications.

[Files]
File modifications: new files (full paths and purpose), existing files to modify (specific changes), files to delete or move, configuration updates.

[Functions]
Function modifications: new functions (name, signature, file path, purpose), modified functions (name, file path, required changes), removed functions (name, file path, migration strategy).

[Classes]
Class modifications: new classes (name, file path, key methods, inheritance), modified classes (name, file path, specific modifications), removed classes (name, file path, replacement strategy).

[Dependencies]
Dependency modifications: new packages, version changes, and integration requirements.

[Testing]
Testing approach: test file requirements, existing test modifications, and validation strategies.

[Implementation Order]
Numbered steps showing the logical order of changes to minimize conflicts and ensure successful integration.


## STEP 4: Hand Off for Implementation

Once the plan document is saved, present a concise summary of the plan to the user and ask whether to proceed with the implementation. Reference the plan document so it can be consulted during implementation (e.g. "Refer to @implementation_plan.md for a complete breakdown"). Do not begin implementing until the user explicitly confirms.

## Quality Standards

Be specific with exact file paths, function names, and class names. Be comprehensive and avoid assuming implicit understanding. Be practical and consider real-world constraints and edge cases. Your implementation plan should be detailed enough that another developer could execute it without additional investigation.

---

**Execute all four steps in sequence. Your role is to plan thoroughly, not to implement. Code creation begins only after the user gives explicit instruction to proceed.**

Below is the user's input when they indicated that they wanted to create a comprehensive implementation plan.
</explicit_instructions>
`

/**
 * `/remember <text>`: the text after the command follows these instructions.
 * Saving goes through the save_memory tool (memory/memory-tools.ts), which
 * works in every mode and places the entry by importance (docs/memory.md).
 */
const REMEMBER_INSTRUCTIONS = `<explicit_instructions type="remember">
The user wants you to remember something for later conversations. Save it with the save_memory tool, then confirm in one short sentence what you saved and where.

- Rewrite it as one clear, self-contained line that will still make sense in a conversation that has none of this context. If it holds several separate facts, save each one with its own call.
- scope: "user" when it is a personal preference that applies to every repository (how they like to work, answer style, tools they use everywhere); otherwise "repo".
- importance: "high" only when forgetting it would cause real mistakes; otherwise "normal".
- If it needs more than one line, keep the line short and put the rest in details, with a topic name.
- If nothing follows the command, save the most important thing learned in this conversation so far, and say what you chose.
- Do not save secrets such as passwords, keys or tokens; tell the user instead.
</explicit_instructions>

What to remember:`

/**
 * Appended after the discovered workflow/skill commands in
 * SdkController.resolveSlashCommands. Declared as kind "skill" so the
 * workflow enable/disable toggles never apply to them.
 */
/**
 * What /remember expands into while memory is off (`plinycode.memory.maxTokens`
 * is 0): there is no save_memory tool then, and instructions to call it would
 * only make the model improvise.
 */
const REMEMBER_WHILE_OFF_INSTRUCTIONS =
	"The user asked to remember something, but PlinyCode's memory is turned off (`plinycode.memory.maxTokens` is 0), so nothing can be saved. Tell the user that, and that they can turn memory on in Settings → Features → Memory. What they wanted remembered:"

/**
 * The built-in commands as the session resolves them: /remember says memory is
 * off when it is, instead of asking for a tool the session does not have.
 */
export function builtinSlashCommands(options: { memoryEnabled: boolean }): AvailableRuntimeCommand[] {
	return options.memoryEnabled
		? BUILTIN_SLASH_COMMANDS
		: BUILTIN_SLASH_COMMANDS.map((command) =>
				command.id === "builtin:remember" ? { ...command, instructions: REMEMBER_WHILE_OFF_INSTRUCTIONS } : command,
			)
}

const BUILTIN_SLASH_COMMANDS: AvailableRuntimeCommand[] = [
	{
		id: "builtin:deep-planning",
		name: "deep-planning",
		instructions: DEEP_PLANNING_INSTRUCTIONS,
		kind: "skill",
	},
	{
		id: "builtin:remember",
		name: "remember",
		instructions: REMEMBER_INSTRUCTIONS,
		kind: "skill",
	},
]
