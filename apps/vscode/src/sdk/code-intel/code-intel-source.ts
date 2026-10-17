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
}
