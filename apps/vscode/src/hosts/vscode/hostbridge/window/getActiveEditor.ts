import * as vscode from "vscode"

import { GetActiveEditorRequest, GetActiveEditorResponse } from "@/shared/proto/index.host"

// Documents that live on disk: local files, and the same files seen through a remote window.
const FILE_SCHEMES = new Set(["file", "vscode-remote"])

export async function getActiveEditor(_: GetActiveEditorRequest): Promise<GetActiveEditorResponse> {
	const editor = vscode.window.activeTextEditor
	if (!editor) {
		return { filePath: undefined }
	}

	const { document, selection } = editor
	const startLine = selection.start.line + 1
	// Selecting whole lines leaves the selection's end at column 0 of the next
	// line, which is not a line the user selected.
	const endsBeforeLineStart = !selection.isEmpty && selection.end.character === 0 && selection.end.line > selection.start.line
	const endLine = endsBeforeLineStart ? selection.end.line : selection.end.line + 1

	return {
		filePath: document.uri.fsPath,
		selectionStartLine: startLine,
		selectionEndLine: endLine,
		isFile: !document.isUntitled && FILE_SCHEMES.has(document.uri.scheme),
	}
}
