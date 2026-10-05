import * as vscode from "vscode"

/** VS Code settings section that holds every `plinycode.context.*` setting. */
const CONTEXT_SETTINGS_SECTION = "plinycode.context"

function readContextToggle(setting: string): boolean {
	try {
		// Both settings default to on; only an explicit `false` turns one off.
		return vscode.workspace.getConfiguration(CONTEXT_SETTINGS_SECTION).get<boolean>(setting, true) !== false
	} catch {
		// Hosts without VS Code's configuration API keep the default.
		return true
	}
}

/**
 * `plinycode.context.gitSnapshot`: put the repository's branch, status and
 * latest commits, as they were when the conversation started, in the system
 * prompt. See sdk/context/conversation-git-snapshots.ts.
 */
export function isGitSnapshotEnabled(): boolean {
	return readContextToggle("gitSnapshot")
}

/**
 * `plinycode.context.editorState`: attach the active file, the cursor or
 * selection and the open tabs to the messages the user sends. See
 * sdk/context/editor-state.ts.
 */
export function isEditorStateEnabled(): boolean {
	return readContextToggle("editorState")
}
