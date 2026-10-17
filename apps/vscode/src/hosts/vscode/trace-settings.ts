import * as vscode from "vscode"

/** VS Code settings section that holds every `plinycode.trace.*` setting. */
const TRACE_SETTINGS_SECTION = "plinycode.trace"

/**
 * `plinycode.trace.enabled`: whether each conversation's requests, replies,
 * tool calls and routing decisions are written to its trace file
 * (sdk/trace/session-trace.ts).
 */
const ENABLED_SETTING = "enabled"

/** On unless the user switched it off. Read per record, so a change applies to the next one. */
export function isSessionTraceEnabled(): boolean {
	try {
		return vscode.workspace.getConfiguration(TRACE_SETTINGS_SECTION).get<boolean>(ENABLED_SETTING, true) !== false
	} catch {
		// Hosts without VS Code's configuration API (standalone) keep the default.
		return true
	}
}
