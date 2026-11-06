import * as vscode from "vscode"
import { TerminalRegistry } from "./VscodeTerminalRegistry"

/** Reveal a PlinyCode terminal only when the user asks to inspect it. */
export async function showAgentTerminal(): Promise<void> {
	const terminals = TerminalRegistry.getAllTerminals()
		.filter((info) => info.lastCommand)
		.sort((a, b) => Number(b.busy) - Number(a.busy) || b.lastActive - a.lastActive)

	if (terminals.length === 0) {
		void vscode.window.showInformationMessage("PlinyCode has no command terminals to show.")
		return
	}

	if (terminals.length === 1) {
		terminals[0].terminal.show()
		return
	}

	const choice = await vscode.window.showQuickPick(
		terminals.map((info) => ({
			label: `PlinyCode terminal ${info.id}`,
			description: info.busy ? "Running" : "Idle",
			detail: info.lastCommand.replace(/\s+/g, " ").slice(0, 160),
			terminal: info.terminal,
		})),
		{ placeHolder: "Select a PlinyCode command terminal to show" },
	)
	choice?.terminal.show()
}
