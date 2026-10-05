import * as vscode from "vscode"
import type { EditDiagnosticsSource, EditProblem } from "@/sdk/edit-problems"
import { arePathsEqual } from "@/utils/path"

/** VS Code settings section that holds every `plinycode.edits.*` setting. */
const EDITS_SETTINGS_SECTION = "plinycode.edits"

/**
 * `plinycode.edits.reportNewProblems`: whether the result of an edit tells the
 * model which errors the editor reports for the edited files that were not
 * there before. See sdk/edit-problems.ts.
 */
const REPORT_NEW_PROBLEMS_SETTING = "reportNewProblems"

export function isReportNewProblemsEnabled(): boolean {
	try {
		return vscode.workspace.getConfiguration(EDITS_SETTINGS_SECTION).get<boolean>(REPORT_NEW_PROBLEMS_SETTING, true) !== false
	} catch {
		// Hosts without VS Code's configuration API (standalone) keep the default.
		return true
	}
}

/** The diagnostics of the window's language servers, as the edit tools need them. */
export function createVscodeEditDiagnosticsSource(): EditDiagnosticsSource {
	return {
		getErrors: (absolutePath) =>
			vscode.languages
				.getDiagnostics(vscode.Uri.file(absolutePath))
				.filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error)
				.map(toEditProblem),
		onDidChangeDiagnostics: (listener) =>
			vscode.languages.onDidChangeDiagnostics((event) => {
				const paths = event.uris.filter((uri) => uri.scheme === "file").map((uri) => uri.fsPath)
				if (paths.length > 0) {
					listener(paths)
				}
			}),
		documentVersion: (absolutePath) =>
			vscode.workspace.textDocuments.find(
				(document) => document.uri.scheme === "file" && arePathsEqual(document.uri.fsPath, absolutePath),
			)?.version,
		isShown: (absolutePath) => findTabs(absolutePath).length > 0,
		showInBackground,
	}
}

function toEditProblem(diagnostic: vscode.Diagnostic): EditProblem {
	const code = typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code
	return {
		line: diagnostic.range.start.line + 1,
		message: diagnostic.message,
		source: diagnostic.source,
		code: code === undefined ? undefined : String(code),
	}
}

/** The tabs that show the file itself: a text editor, or the modified side of a diff. */
function findTabs(absolutePath: string): vscode.Tab[] {
	return vscode.window.tabGroups.all.flatMap((group) =>
		group.tabs.filter((tab) => {
			const uri =
				tab.input instanceof vscode.TabInputText
					? tab.input.uri
					: tab.input instanceof vscode.TabInputTextDiff
						? tab.input.modified
						: undefined
			return uri?.scheme === "file" && arePathsEqual(uri.fsPath, absolutePath)
		}),
	)
}

/**
 * Loads the file's document and opens it in a tab behind the visible editor.
 *
 * VS Code's TypeScript and JSON servers only analyse a document that is loaded
 * and has a tab; `workspace.openTextDocument` alone gets no diagnostics from
 * them, and a background tab alone leaves its document unloaded. Hence both
 * calls, the document first so that a file that cannot be loaded gets no tab.
 * Neither moves the focus or changes the visible editor, unless the editor area
 * is empty, where the new tab is the only one and so the visible one.
 */
async function showInBackground(absolutePath: string): Promise<() => Promise<void>> {
	const uri = vscode.Uri.file(absolutePath)
	await vscode.workspace.openTextDocument(uri)
	await vscode.commands.executeCommand("vscode.open", uri, { background: true, preview: false, preserveFocus: true })
	return async () => {
		for (const tab of findTabs(absolutePath)) {
			// A tab that is visible by now is one the user is looking at: leave it.
			if (!tab.isActive && !tab.isDirty) {
				await vscode.window.tabGroups.close(tab, true)
			}
		}
	}
}
