import * as vscode from "vscode"

/** An untitled draft leaves the repository file available for review before saving. */
export async function openMemoryPromotionDraft(file: string, current: string, text: string): Promise<void> {
	const existing = vscode.workspace.textDocuments.find((document) => document.uri.fsPath.toLowerCase() === file.toLowerCase())
	const draft = await vscode.workspace.openTextDocument({
		content: `${(existing?.getText() ?? current).trimEnd()}\n\n- ${text}\n`,
		language: "markdown",
	})
	await vscode.window.showTextDocument(draft, { preview: false })
	await vscode.window.showInformationMessage(
		`Promotion draft opened. Review and save it as ${file}, then choose Finish promotion in Memory.`,
	)
}
