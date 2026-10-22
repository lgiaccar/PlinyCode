import * as vscode from "vscode"

const DEFAULT_WAIT_MINUTES = 60

/** Cumulative time spent in `wait` calls during one agent turn. Zero disables the limit. */
export function getMaxWaitMinutesPerTurn(): number {
	try {
		const value = vscode.workspace.getConfiguration("plinycode.wait").get<number>("maxMinutesPerTurn", DEFAULT_WAIT_MINUTES)
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_WAIT_MINUTES
	} catch {
		return DEFAULT_WAIT_MINUTES
	}
}

export async function setMaxWaitMinutesPerTurn(minutes: number): Promise<void> {
	if (!Number.isFinite(minutes) || minutes < 0) throw new Error(`Invalid wait limit: ${minutes}`)
	await vscode.workspace
		.getConfiguration("plinycode.wait")
		.update("maxMinutesPerTurn", minutes, vscode.ConfigurationTarget.Global)
}
