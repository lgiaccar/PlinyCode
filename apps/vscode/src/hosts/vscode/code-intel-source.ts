import * as vscode from "vscode"
import { reduceHoverMarkdown } from "@/sdk/code-intel/code-intel-format"
import type { CodeHover, CodeIntelSource, CodeLocation, CodeSymbol } from "@/sdk/code-intel/code-intel-source"

/** VS Code settings section that holds every `plinycode.codeIntel.*` setting. */
const CODE_INTEL_SETTINGS_SECTION = "plinycode.codeIntel"

/**
 * `plinycode.codeIntel.enabled`: whether the model gets the `find_symbol` and
 * `code_navigate` tools, which answer through the window's language servers.
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
 * commands. Each answer is reduced to plain one-based positions so the tools
 * and their tests never see a `vscode.Uri` or `vscode.Range`.
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
