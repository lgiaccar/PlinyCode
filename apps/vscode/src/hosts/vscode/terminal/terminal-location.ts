import * as vscode from "vscode"

/**
 * Where PlinyCode opens its terminals (`plinycode.terminal.location`): the
 * panel, or a tab in the editor area. Programs lay their output out to the
 * terminal's width before PlinyCode reads it, and a panel docked beside the
 * editor is often only 30–60 columns wide; an editor tab is usually as wide
 * as the window.
 */
export type TerminalLocation = "panel" | "editor"

const SECTION = "plinycode.terminal"

export function readTerminalLocation(): TerminalLocation {
	return vscode.workspace.getConfiguration(SECTION).get<string>("location") === "editor" ? "editor" : "panel"
}

export async function setTerminalLocation(location: TerminalLocation): Promise<void> {
	await vscode.workspace.getConfiguration(SECTION).update("location", location, vscode.ConfigurationTarget.Global)
}

/** Whether to warn the user, once per window, that the terminal is too narrow (`plinycode.terminal.narrowWarning`). */
export function isNarrowTerminalWarningEnabled(): boolean {
	return vscode.workspace.getConfiguration(SECTION).get<boolean>("narrowWarning") !== false
}

export async function disableNarrowTerminalWarning(): Promise<void> {
	await vscode.workspace.getConfiguration(SECTION).update("narrowWarning", false, vscode.ConfigurationTarget.Global)
}

/**
 * `createTerminal`'s location for a terminal in `location`. An editor
 * terminal opens in the active group, not beside it, since a split halves
 * the width, and without taking focus from what the user is typing in.
 */
export function terminalLocationOption(location: TerminalLocation): vscode.TerminalOptions["location"] {
	return location === "editor" ? { viewColumn: vscode.ViewColumn.Active, preserveFocus: true } : undefined
}
