import * as vscode from "vscode"

const CHAT_SETTINGS_SECTION = "plinycode.chat"
const FONT_SIZE_SETTING = "fontSize"

/** Default and limits mirror `package.json` contributes.configuration. */
const DEFAULT_CHAT_FONT_SIZE = 13
const MIN_CHAT_FONT_SIZE = 10
const MAX_CHAT_FONT_SIZE = 24

/**
 * `plinycode.chat.fontSize`: the font size in pixels for the chat panel.
 * Read when building ExtensionState, so a change in VS Code settings
 * takes effect after the next state push (triggered by the change listener
 * in extension.ts).
 */
export function getChatFontSize(): number {
	try {
		const value = Number(
			vscode.workspace.getConfiguration(CHAT_SETTINGS_SECTION).get<number>(FONT_SIZE_SETTING, DEFAULT_CHAT_FONT_SIZE),
		)
		return Number.isFinite(value) ? Math.min(MAX_CHAT_FONT_SIZE, Math.max(MIN_CHAT_FONT_SIZE, value)) : DEFAULT_CHAT_FONT_SIZE
	} catch {
		// Hosts without VS Code's configuration API keep the default.
		return DEFAULT_CHAT_FONT_SIZE
	}
}
