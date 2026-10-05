/**
 * Plan-Mode and Ask-Mode Command Guard Extensions
 *
 * Runtime extensions that enforce a mode's write rules as a `beforeTool`
 * hook. The runtime builder registers the matching one for plan-mode and
 * ask-mode sessions, making them session policy in one shared place: the hook fires for every matching tool
 * in the runtime — the SDK built-ins and host-provided replacements like the
 * VS Code extension's terminal-backed tool — without threading a flag through
 * each layer.
 *
 * - `run_commands`: rejects commands on the file-editing blacklist
 *   (./command-guard.ts).
 * - `editor` / `apply_patch`: plan mode writes its plan as markdown files, so
 *   these are allowed only when every target path is a markdown file. Ask
 *   mode answers questions and writes nothing, so it rejects them all.
 *
 * Because `beforeTool` hooks run before tool policies and user approval,
 * a blocked call is rejected up front: the user is never asked to approve a
 * call that would only fail, and the model receives the mode's error
 * as the tool result (`skip`, not `stop`, so the run continues).
 */

import type {
	AgentBeforeToolContext,
	AgentBeforeToolResult,
	AgentExtension,
} from "@plinycode/shared";
import {
	findFileEditingCommand,
	findPatchFilePaths,
	formatAskModeBlockedCommandError,
	formatAskModeBlockedWriteError,
	formatOffTheRecordBlockedError,
	formatPlanModeBlockedCommandError,
	formatPlanModeBlockedWriteError,
	isMarkdownPath,
} from "./command-guard";
import { DefaultToolNames } from "./constants";
import { normalizeRunCommandsInput } from "./helpers";

export const PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME =
	"core.plan-mode-command-guard";
export const ASK_MODE_COMMAND_GUARD_EXTENSION_NAME =
	"core.ask-mode-command-guard";

function guardRunCommands(
	input: unknown,
	formatError: (reason: string) => string,
): AgentBeforeToolResult | undefined {
	let commands: ReturnType<typeof normalizeRunCommandsInput>;
	try {
		commands = normalizeRunCommandsInput(input);
	} catch {
		// Unparseable input: let the tool produce its own validation error.
		return undefined;
	}

	for (const command of commands) {
		const blocked = findFileEditingCommand(command);
		if (blocked) {
			return {
				skip: true,
				reason: formatError(blocked),
			};
		}
	}
	return undefined;
}

function guardEditor(input: unknown): AgentBeforeToolResult | undefined {
	const path =
		input && typeof input === "object"
			? (input as { path?: unknown }).path
			: undefined;
	if (typeof path === "string" && isMarkdownPath(path)) {
		return undefined;
	}
	return {
		skip: true,
		reason: formatPlanModeBlockedWriteError(
			typeof path === "string" && path.trim() ? path : undefined,
		),
	};
}

function guardApplyPatch(input: unknown): AgentBeforeToolResult | undefined {
	const patch =
		typeof input === "string"
			? input
			: input && typeof input === "object"
				? (input as { input?: unknown }).input
				: undefined;
	const paths = typeof patch === "string" ? findPatchFilePaths(patch) : [];
	// A patch with no parseable file header could still write somewhere, so
	// it is rejected rather than waved through.
	const offending =
		paths.length === 0 ? undefined : paths.find((p) => !isMarkdownPath(p));
	if (paths.length > 0 && offending === undefined) {
		return undefined;
	}
	return {
		skip: true,
		reason: formatPlanModeBlockedWriteError(offending),
	};
}

export function createPlanModeCommandGuardExtension(): AgentExtension {
	const beforeTool = (
		context: AgentBeforeToolContext,
	): AgentBeforeToolResult | undefined => {
		switch (context.tool.name) {
			case DefaultToolNames.RUN_COMMANDS:
				return guardRunCommands(
					context.input,
					formatPlanModeBlockedCommandError,
				);
			case DefaultToolNames.EDITOR:
				return guardEditor(context.input);
			case DefaultToolNames.APPLY_PATCH:
				return guardApplyPatch(context.input);
			default:
				return undefined;
		}
	};

	return {
		name: PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME,
		manifest: {
			capabilities: ["hooks"],
		},
		hooks: {
			beforeTool,
		},
	};
}

/** The file an `editor` or `apply_patch` call would write, for the error text. */
function findWriteTarget(toolName: string, input: unknown): string | undefined {
	if (toolName === DefaultToolNames.EDITOR) {
		const path =
			input && typeof input === "object"
				? (input as { path?: unknown }).path
				: undefined;
		return typeof path === "string" && path.trim() ? path : undefined;
	}
	const patch =
		typeof input === "string"
			? input
			: input && typeof input === "object"
				? (input as { input?: unknown }).input
				: undefined;
	return typeof patch === "string" ? findPatchFilePaths(patch)[0] : undefined;
}

/**
 * Ask mode answers questions and never writes a file. Its preset already
 * leaves the editor and apply_patch tools out; this guard is the backstop for
 * a host or sub-agent that still exposes one, and for file-editing shell
 * commands.
 */
export function createAskModeCommandGuardExtension(): AgentExtension {
	const beforeTool = (
		context: AgentBeforeToolContext,
	): AgentBeforeToolResult | undefined => {
		switch (context.tool.name) {
			case DefaultToolNames.RUN_COMMANDS:
				return guardRunCommands(
					context.input,
					formatAskModeBlockedCommandError,
				);
			case DefaultToolNames.EDITOR:
			case DefaultToolNames.APPLY_PATCH:
				return {
					skip: true,
					reason: formatAskModeBlockedWriteError(
						findWriteTarget(context.tool.name, context.input),
					),
				};
			default:
				return undefined;
		}
	};

	return {
		name: ASK_MODE_COMMAND_GUARD_EXTENSION_NAME,
		manifest: {
			capabilities: ["hooks"],
		},
		hooks: {
			beforeTool,
		},
	};
}

/**
 * Tools an off-the-record turn may not call even though they write no file:
 * the task list is shown to the user and kept across turns, and sub-agents
 * and teammates run outside this guard.
 */
function isOffTheRecordBlockedTool(name: string): boolean {
	return (
		name === "update_todo_list" ||
		name === "spawn_agent" ||
		name.startsWith("subagent_") ||
		name.startsWith("team_")
	);
}

/**
 * The `beforeTool` check for a run that answers an off-the-record message
 * (see session/off-the-record.ts). The turn is left out of the context
 * afterwards, so a change it made would be one the conversation was never
 * told about: like ask mode, it rejects file writes and file-editing
 * commands, and also tools that change state kept across turns. The session
 * runtime applies it only during such runs, whatever the session's mode.
 */
export function guardOffTheRecordTool(
	context: AgentBeforeToolContext,
): AgentBeforeToolResult | undefined {
	const name = context.tool.name;
	switch (name) {
		case DefaultToolNames.RUN_COMMANDS:
			return guardRunCommands(context.input, (reason) =>
				formatOffTheRecordBlockedError(`${reason} can modify files`),
			);
		case DefaultToolNames.EDITOR:
		case DefaultToolNames.APPLY_PATCH: {
			const target = findWriteTarget(name, context.input);
			return {
				skip: true,
				reason: formatOffTheRecordBlockedError(
					`${target ? `\`${target}\`` : "the file"} was not changed`,
				),
			};
		}
		default:
			return isOffTheRecordBlockedTool(name)
				? {
						skip: true,
						reason: formatOffTheRecordBlockedError(`${name} was not called`),
					}
				: undefined;
	}
}
