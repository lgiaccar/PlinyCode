// Dependency-free so hosts (and their test stubs) can import it cheaply.

const ABORTED_COMMAND_PREVIEW_MAX_CHARS = 200;

/**
 * Maps a run abort reason (usually the AgentRuntimeAbortError carried by the
 * tool's AbortSignal) to a short human-readable cause for error messages.
 */
export function describeAbortReason(reason: unknown): string {
	const raw =
		typeof reason === "string"
			? reason
			: reason instanceof Error
				? typeof (reason as { reason?: unknown }).reason === "string"
					? ((reason as { reason?: unknown }).reason as string)
					: reason.message
				: undefined;
	const text = raw?.trim() ?? "";
	if (!text || text === "Run aborted" || text === "user_cancel") {
		return "cancelled by user";
	}
	if (text === "session_stop" || text.includes("shutdown")) {
		return "task stopped or switched";
	}
	if (text.includes("mistake")) {
		return "stopped after repeated errors";
	}
	return text;
}

/**
 * Thrown by shell executors when the run is aborted while a command is waiting
 * or running. Carries the command and any partial output so the tool result
 * can tell the user (and the model) exactly what was interrupted.
 */
export class CommandAbortedError extends Error {
	readonly command: string;
	readonly cwd: string;
	readonly reason: string;
	readonly output: string;

	constructor(options: {
		command: string;
		cwd: string;
		reason?: unknown;
		output?: string;
	}) {
		const reason = describeAbortReason(options.reason);
		const command =
			options.command.length > ABORTED_COMMAND_PREVIEW_MAX_CHARS
				? `${options.command.slice(0, ABORTED_COMMAND_PREVIEW_MAX_CHARS)}…`
				: options.command;
		// Keep the "Command execution aborted" prefix: callers (e.g. the router's
		// tool-failure classifier) match on it.
		super(
			`Command execution aborted (${reason}): \`${command}\` in ${options.cwd}`,
		);
		this.name = "CommandAbortedError";
		this.command = options.command;
		this.cwd = options.cwd;
		this.reason = reason;
		this.output = options.output ?? "";
	}
}
