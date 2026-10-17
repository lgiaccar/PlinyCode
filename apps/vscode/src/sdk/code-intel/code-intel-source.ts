/**
 * What the code intelligence tools need from the editor host: the answers of
 * the window's language servers, reduced to plain data. The VS Code
 * implementation is hosts/vscode/code-intel-source.ts; tests pass a fake.
 *
 * Lines and columns are one-based everywhere in this interface. A method
 * resolves to `undefined` when the host could not even ask (the file does not
 * exist or cannot be opened); an empty array means the servers answered with
 * nothing, which the tool treats the same way since VS Code does not say
 * whether a provider was registered for the file.
 */

export interface CodeLocation {
	/** Absolute path of the file. */
	path: string
	line: number
	column: number
}

export interface CodeSymbol {
	name: string
	/** Lower-case symbol kind: `function`, `class`, `method`, `variable`, … */
	kind: string
	path: string
	line: number
	column: number
	/** The enclosing symbol, when the host reports one (a class for a method, a namespace for a class). */
	container?: string
	/** Nesting depth in a document outline, 0 for top-level symbols. */
	depth?: number
}

export interface CodeHover {
	/** The code-fenced parts of the hover: signatures and types, one line each. */
	signature: string[]
	/** The prose parts of the hover, markdown stripped, one paragraph line each. */
	documentation: string[]
}

export type CallDirection = "incoming" | "outgoing"

/** One entry of a call hierarchy: a function that calls the symbol, or one it calls. */
export interface CodeCall {
	name: string
	/** Lower-case symbol kind, as for `CodeSymbol`. */
	kind: string
	/** Where the caller or callee is declared. */
	path: string
	line: number
	column: number
	/**
	 * The first call site: inside the caller for incoming calls, inside the
	 * symbol itself for outgoing ones. Absent when the server reports none.
	 */
	callSite?: CodeLocation
}

export interface CodeCallHierarchy {
	/** The symbol the hierarchy was prepared for. */
	item: CodeCall
	calls: CodeCall[]
}

export interface CodeDiagnostic {
	severity: "error" | "warning"
	message: string
	line: number
	column: number
	/** Who reported it: `ts`, `eslint`, `Pylance`, … */
	source?: string
	code?: string
}

/** One text replacement of a rename, with a one-based range in the file as it is now. */
export interface CodeTextEdit {
	line: number
	column: number
	endLine: number
	endColumn: number
	newText: string
}

export interface CodeRenameResult {
	/** The server's reason for refusing, when it refused (the position cannot be renamed). */
	refusal?: string
	/** The text edits per file, in the order the server returned them. */
	files: { path: string; edits: CodeTextEdit[] }[]
}

/** The errors one file reports, for a workspace-wide problems list. */
export interface CodeFileDiagnostics {
	path: string
	diagnostics: CodeDiagnostic[]
}

/** What applying a rename did. */
export interface CodeRenameApplication {
	/** The server's reason for refusing, when it refused; nothing was applied then. */
	refusal?: string
	/** False when the editor did not apply the edit (a file changed under it, or is read-only). */
	applied: boolean
	/**
	 * The text edits applied per file. File operations that came with them (a
	 * server that renames a class's file with the class) are applied too, but
	 * VS Code's API does not list them.
	 */
	files: { path: string; edits: CodeTextEdit[] }[]
	/** Files with text edits that could not be saved, so the change is in the editor only. */
	unsaved: string[]
	/** Files that had unsaved changes in the editor before the rename; saving it saved those too. */
	hadUnsavedChanges: string[]
}

export interface CodeIntelSource {
	/** Loads the file into the editor so its language server analyses it, and returns its text. */
	readDocument(absolutePath: string): Promise<string | undefined>
	/** One line of a file, for previews; undefined when the file or line does not exist. */
	readLine(absolutePath: string, line: number): Promise<string | undefined>
	/** The outline of one file, nested symbols flattened with `depth`. */
	documentSymbols(absolutePath: string): Promise<CodeSymbol[] | undefined>
	/** Symbols across the workspace whose names match the query (the servers decide how loosely). */
	workspaceSymbols(query: string): Promise<CodeSymbol[] | undefined>
	definitions(absolutePath: string, line: number, column: number): Promise<CodeLocation[] | undefined>
	references(absolutePath: string, line: number, column: number): Promise<CodeLocation[] | undefined>
	hover(absolutePath: string, line: number, column: number): Promise<CodeHover | undefined>
	/**
	 * One level of the call hierarchy of the symbol at the position: its callers
	 * (`incoming`) or the functions it calls (`outgoing`). Undefined when no
	 * server prepared a hierarchy item there.
	 */
	callHierarchy(
		absolutePath: string,
		line: number,
		column: number,
		direction: CallDirection,
	): Promise<CodeCallHierarchy | undefined>
	/** The errors and warnings the editor currently reports for the file. */
	diagnostics(absolutePath: string): Promise<CodeDiagnostic[] | undefined>
	/**
	 * The errors (not warnings) the editor currently reports across the window,
	 * one entry per file with at least one. Dependencies and git's own files are
	 * left out.
	 */
	workspaceErrors(): Promise<CodeFileDiagnostics[] | undefined>
	/** The edits a rename at the position would make, without applying them. */
	renameEdits(absolutePath: string, line: number, column: number, newName: string): Promise<CodeRenameResult | undefined>
	/**
	 * Asks for the rename at the position again and applies the server's whole
	 * edit (file operations included), then saves every file it edited.
	 * Undefined when no server answered with an edit.
	 */
	applyRename(absolutePath: string, line: number, column: number, newName: string): Promise<CodeRenameApplication | undefined>
}
