import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { HostProvider } from "@/hosts/host-provider"
import type { EditDiagnosticsSource, EditProblem } from "@/sdk/edit-problems"
import { arePathsEqual, isLocatedInPath } from "@/utils/path"

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
		getErrors: (absolutePath) => errorsOf(vscode.languages.getDiagnostics(vscode.Uri.file(absolutePath))),
		getAllErrors: () => {
			const result = new Map<string, EditProblem[]>()
			const dataDirectories = plinyCodeDataDirectories()
			for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
				if (uri.scheme !== "file" || isExcludedPath(uri.fsPath, dataDirectories)) {
					continue
				}
				const errors = errorsOf(diagnostics)
				if (errors.length > 0) {
					result.set(uri.fsPath, errors)
				}
			}
			return result
		},
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

function errorsOf(diagnostics: readonly vscode.Diagnostic[]): EditProblem[] {
	return diagnostics.filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error).map(toEditProblem)
}

/** Directories whose files are not the model's to fix: dependencies and git's own files. */
const EXCLUDED_DIRECTORY_NAMES = new Set(["node_modules", ".git"])

/**
 * PlinyCode's own directories: checkpoints keep copies of workspace files under the
 * extension's global storage, and ~/.cline holds its settings and logs.
 */
function plinyCodeDataDirectories(): string[] {
	const directories = [path.join(os.homedir(), ".cline")]
	try {
		if (HostProvider.isInitialized()) {
			directories.push(HostProvider.get().globalStorageFsPath)
		}
	} catch {
		// Without a host provider (tests) there is nothing more to leave out.
	}
	return directories
}

function isExcludedPath(fsPath: string, dataDirectories: string[]): boolean {
	const normalized = path.normalize(fsPath)
	if (normalized.split(path.sep).some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) {
		return true
	}
	return dataDirectories.some((directory) => isLocatedInPath(directory, normalized))
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
