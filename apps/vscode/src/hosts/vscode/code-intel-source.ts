import * as vscode from "vscode"
import { reduceHoverMarkdown } from "@/sdk/code-intel/code-intel-format"
import type {
	CodeCall,
	CodeDiagnostic,
	CodeHover,
	CodeIntelSource,
	CodeLocation,
	CodeRenameApplication,
	CodeRenameResult,
	CodeSymbol,
	CodeTextEdit,
} from "@/sdk/code-intel/code-intel-source"
import { workspaceDiagnosticEntries } from "./edit-diagnostics"

/** VS Code settings section that holds every `plinycode.codeIntel.*` setting. */
const CODE_INTEL_SETTINGS_SECTION = "plinycode.codeIntel"

/**
 * `plinycode.codeIntel.enabled`: whether the model gets the `find_symbol`,
 * `code_navigate`, `rename_preview` and `rename_symbol` tools, which answer
 * through the window's language servers.
 * See sdk/code-intel/code-intel-tools.ts.
 */
const CODE_INTEL_ENABLED_SETTING = "enabled"

export function isCodeIntelEnabled(): boolean {
	try {
		return (
			vscode.workspace.getConfiguration(CODE_INTEL_SETTINGS_SECTION).get<boolean>(CODE_INTEL_ENABLED_SETTING, true) !==
			false
		)
	} catch {
		// Hosts without VS Code's configuration API keep the default.
		return true
	}
}

/**
 * The window's language servers, through VS Code's `vscode.execute*Provider`
 * and call hierarchy commands and its diagnostics. Each answer is reduced to
 * plain one-based positions so the tools and their tests never see a
 * `vscode.Uri` or `vscode.Range`.
 */
export function createVscodeCodeIntelSource(): CodeIntelSource {
	return {
		async readDocument(absolutePath) {
			try {
				const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath))
				return document.getText()
			} catch {
				return undefined
			}
		},
		async readLine(absolutePath, line) {
			try {
				const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath))
				return line >= 1 && line <= document.lineCount ? document.lineAt(line - 1).text : undefined
			} catch {
				return undefined
			}
		},
		async documentSymbols(absolutePath) {
			const uri = vscode.Uri.file(absolutePath)
			const result = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>(
				"vscode.executeDocumentSymbolProvider",
				uri,
			)
			if (!result) {
				return undefined
			}
			const symbols: CodeSymbol[] = []
			const visit = (
				entries: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
				depth: number,
				container?: string,
			) => {
				for (const entry of entries) {
					if (entry instanceof vscode.DocumentSymbol) {
						const start = entry.selectionRange.start
						symbols.push({
							name: entry.name,
							kind: kindName(entry.kind),
							path: absolutePath,
							line: start.line + 1,
							column: start.character + 1,
							container,
							depth,
						})
						if (entry.children.length > 0) {
							visit(entry.children, depth + 1, entry.name)
						}
					} else {
						symbols.push(fromSymbolInformation(entry, depth))
					}
				}
			}
			visit(result, 0)
			return symbols
		},
		async workspaceSymbols(query) {
			const result = await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
				"vscode.executeWorkspaceSymbolProvider",
				query,
			)
			return result
				?.filter((symbol) => symbol.location.uri.scheme === "file")
				.map((symbol) => fromSymbolInformation(symbol))
		},
		async definitions(absolutePath, line, column) {
			const result = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>(
				"vscode.executeDefinitionProvider",
				vscode.Uri.file(absolutePath),
				new vscode.Position(line - 1, column - 1),
			)
			return result?.map(fromLocation).filter((location): location is CodeLocation => !!location)
		},
		async references(absolutePath, line, column) {
			const result = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
				"vscode.executeReferenceProvider",
				vscode.Uri.file(absolutePath),
				new vscode.Position(line - 1, column - 1),
			)
			return result?.map(fromLocation).filter((location): location is CodeLocation => !!location)
		},
		async hover(absolutePath, line, column): Promise<CodeHover | undefined> {
			const result = await vscode.commands.executeCommand<vscode.Hover[] | undefined>(
				"vscode.executeHoverProvider",
				vscode.Uri.file(absolutePath),
				new vscode.Position(line - 1, column - 1),
			)
			if (!result || result.length === 0) {
				return undefined
			}
			const values = result.flatMap((hover) =>
				hover.contents.map((content) => {
					if (typeof content === "string") {
						return content
					}
					if (content instanceof vscode.MarkdownString) {
						return content.value
					}
					// A legacy MarkedString: `{ language, value }`.
					return `\`\`\`${content.language}\n${content.value}\n\`\`\``
				}),
			)
			return reduceHoverMarkdown(values)
		},
		async callHierarchy(absolutePath, line, column, direction) {
			const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[] | undefined>(
				"vscode.prepareCallHierarchy",
				vscode.Uri.file(absolutePath),
				new vscode.Position(line - 1, column - 1),
			)
			const item = items?.[0]
			const prepared = item && fromCallItem(item)
			if (!item || !prepared) {
				return undefined
			}
			const calls: (CodeCall | undefined)[] = []
			if (direction === "incoming") {
				const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[] | undefined>(
					"vscode.provideIncomingCalls",
					item,
				)
				// The call sites of an incoming call are ranges in the caller's file.
				for (const call of incoming ?? []) {
					calls.push(fromCallItem(call.from, call.from.uri, call.fromRanges[0]))
				}
			} else {
				const outgoing = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[] | undefined>(
					"vscode.provideOutgoingCalls",
					item,
				)
				// The call sites of an outgoing call are ranges in the prepared item's file.
				for (const call of outgoing ?? []) {
					calls.push(fromCallItem(call.to, item.uri, call.fromRanges[0]))
				}
			}
			return { item: prepared, calls: calls.filter((call): call is CodeCall => !!call) }
		},
		async diagnostics(absolutePath) {
			return vscode.languages.getDiagnostics(vscode.Uri.file(absolutePath)).flatMap(toCodeDiagnostics)
		},
		async workspaceErrors() {
			return workspaceDiagnosticEntries().flatMap(([uri, diagnostics]) => {
				const errors = diagnostics
					.filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error)
					.flatMap(toCodeDiagnostics)
				return errors.length > 0 ? [{ path: uri.fsPath, diagnostics: errors }] : []
			})
		},
		async renameEdits(absolutePath, line, column, newName): Promise<CodeRenameResult | undefined> {
			const answer = await requestRename(absolutePath, line, column, newName)
			if (!answer) {
				return undefined
			}
			return "refusal" in answer ? { refusal: answer.refusal, files: [] } : { files: textEditsOf(answer.edit) }
		},
		async applyRename(absolutePath, line, column, newName): Promise<CodeRenameApplication | undefined> {
			const answer = await requestRename(absolutePath, line, column, newName)
			if (!answer) {
				return undefined
			}
			if ("refusal" in answer) {
				return { refusal: answer.refusal, applied: false, files: [], unsaved: [], hadUnsavedChanges: [] }
			}
			const files = textEditsOf(answer.edit)
			const uris = answer.edit
				.entries()
				.map(([uri]) => uri)
				.filter((uri) => uri.scheme === "file")
			const openDocument = (uri: vscode.Uri) =>
				vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
			const hadUnsavedChanges = uris.filter((uri) => openDocument(uri)?.isDirty).map((uri) => uri.fsPath)
			// The whole edit, file operations included: a server that renames a class's
			// file with the class gets both, as the editor's own rename would.
			const applied = await vscode.workspace.applyEdit(answer.edit)
			if (!applied) {
				return { applied: false, files, unsaved: [], hadUnsavedChanges }
			}
			// applyEdit changes the documents in memory; the checkpoints, the other tools
			// and the user's build all read the files on disk.
			const unsaved: string[] = []
			for (const uri of uris) {
				try {
					const document = openDocument(uri) ?? (await vscode.workspace.openTextDocument(uri))
					if (document.isDirty && !(await document.save())) {
						unsaved.push(uri.fsPath)
					}
				} catch {
					unsaved.push(uri.fsPath)
				}
			}
			return { applied: true, files, unsaved, hadUnsavedChanges }
		},
	}
}

/** The rename provider's edit, or its refusal; undefined when no provider answered. */
async function requestRename(
	absolutePath: string,
	line: number,
	column: number,
	newName: string,
): Promise<{ edit: vscode.WorkspaceEdit } | { refusal: string } | undefined> {
	try {
		const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
			"vscode.executeDocumentRenameProvider",
			vscode.Uri.file(absolutePath),
			new vscode.Position(line - 1, column - 1),
			newName,
		)
		return edit ? { edit } : undefined
	} catch (error) {
		// VS Code turns a provider's refusal ("You cannot rename this element.") into a rejected command.
		const reason = error instanceof Error ? error.message : String(error)
		return { refusal: reason.trim() || "the language server gave no reason." }
	}
}

/** The text edits of a workspace edit, per file on disk, as one-based plain data. */
function textEditsOf(edit: vscode.WorkspaceEdit): { path: string; edits: CodeTextEdit[] }[] {
	return edit
		.entries()
		.filter(([uri]) => uri.scheme === "file")
		.map(([uri, edits]) => ({
			path: uri.fsPath,
			edits: edits.map((textEdit) => ({
				line: textEdit.range.start.line + 1,
				column: textEdit.range.start.character + 1,
				endLine: textEdit.range.end.line + 1,
				endColumn: textEdit.range.end.character + 1,
				newText: textEdit.newText,
			})),
		}))
}

/** An error or warning as plain data; information and hints are left out. */
function toCodeDiagnostics(diagnostic: vscode.Diagnostic): CodeDiagnostic[] {
	const severity =
		diagnostic.severity === vscode.DiagnosticSeverity.Error
			? "error"
			: diagnostic.severity === vscode.DiagnosticSeverity.Warning
				? "warning"
				: undefined
	if (!severity) {
		return []
	}
	const code = typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code
	return [
		{
			severity,
			message: diagnostic.message,
			line: diagnostic.range.start.line + 1,
			column: diagnostic.range.start.character + 1,
			source: diagnostic.source || undefined,
			code: code === undefined || code === "" ? undefined : String(code),
		},
	]
}

/** A call hierarchy item as plain data, with the call site when one is given. */
function fromCallItem(item: vscode.CallHierarchyItem, siteUri?: vscode.Uri, siteRange?: vscode.Range): CodeCall | undefined {
	if (item.uri.scheme !== "file") {
		return undefined
	}
	const start = item.selectionRange.start
	const callSite: CodeLocation | undefined =
		siteUri && siteRange && siteUri.scheme === "file"
			? { path: siteUri.fsPath, line: siteRange.start.line + 1, column: siteRange.start.character + 1 }
			: undefined
	return {
		name: item.name,
		kind: kindName(item.kind),
		path: item.uri.fsPath,
		line: start.line + 1,
		column: start.character + 1,
		callSite,
	}
}

function kindName(kind: vscode.SymbolKind): string {
	return (vscode.SymbolKind[kind] ?? "symbol").toLowerCase()
}

function fromSymbolInformation(symbol: vscode.SymbolInformation, depth?: number): CodeSymbol {
	const start = symbol.location.range.start
	return {
		name: symbol.name,
		kind: kindName(symbol.kind),
		path: symbol.location.uri.fsPath,
		line: start.line + 1,
		column: start.character + 1,
		container: symbol.containerName || undefined,
		depth,
	}
}

function fromLocation(entry: vscode.Location | vscode.LocationLink): CodeLocation | undefined {
	const uri = "targetUri" in entry ? entry.targetUri : entry.uri
	const range = "targetUri" in entry ? (entry.targetSelectionRange ?? entry.targetRange) : entry.range
	if (uri.scheme !== "file") {
		return undefined
	}
	return { path: uri.fsPath, line: range.start.line + 1, column: range.start.character + 1 }
}
