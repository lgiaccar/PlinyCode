/**
 * Plan-Mode Command Guard Extension
 *
 * Runtime extension that enforces plan mode's write rules as a `beforeTool`
 * hook. The runtime builder registers it for plan-mode sessions, making them
 * session policy in one shared place: the hook fires for every matching tool
 * in the runtime — the SDK built-ins and host-provided replacements like the
 * VS Code extension's terminal-backed tool — without threading a flag through
 * each layer.
 *
 * - `run_commands`: rejects commands on the file-editing blacklist
 *   (./command-guard.ts).
 * - `editor` / `apply_patch`: plan mode writes its plan as markdown files, so
 *   these are allowed only when every target path is a markdown file.
 *
 * Because `beforeTool` hooks run before tool policies and user approval,
 * a blocked call is rejected up front: the user is never asked to approve a
 * call that would only fail, and the model receives the plan-mode error
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
	formatPlanModeBlockedCommandError,
	formatPlanModeBlockedWriteError,
	isMarkdownPath,
} from "./command-guard";
import { DefaultToolNames } from "./constants";
import { normalizeRunCommandsInput } from "./helpers";

export const PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME =
	"core.plan-mode-command-guard";

function guardRunCommands(input: unknown): AgentBeforeToolResult | undefined {
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
				reason: formatPlanModeBlockedCommandError(blocked),
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
				return guardRunCommands(context.input);
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
