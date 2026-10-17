/**
 * The candidates for `@` mentions in the chat input, from VS Code's own file
 * index (`vscode.workspace.findFiles`) and, for a query that looks like an
 * identifier, the language servers' workspace symbols. The caller
 * (services/search/file-search.ts) ranks them with fzf; this only has to
 * return a set that holds the right files, quickly. A throw sends the caller
 * back to its ripgrep walk.
 *
 * findFiles takes one include glob, so the query becomes a fuzzy glob on file
 * names (`chrow` → `*[cC]*[hH]*[rR]*[oO]*[wW]*`). The caller's fzf also
 * matches across directories (`chat/row`), which no single glob can, so a
 * fuzzy pass that finds few files is topped up with a plain listing for fzf to
 * rank. `files.exclude` and `search.exclude` both apply: findFiles applies only
 * the first by itself, and only when no exclude glob is passed.
 */

import * as path from "path"
import * as vscode from "vscode"
import {
	type SearchWorkspaceItemsRequest,
	SearchWorkspaceItemsRequest_SearchItemType,
	SearchWorkspaceItemsResponse,
	type SearchWorkspaceItemsResponse_SearchItem,
} from "@/shared/proto/host/workspace"

/** The caller asks for 5000 and ranks them itself. */
const DEFAULT_LIMIT = 1_000
const MAX_LIMIT = 5_000
/** A fuzzy pass with fewer files than this is topped up with a plain listing. */
const SPARSE_RESULTS = 50
/** Files listed to find the folders whose names match. */
const FOLDER_PASS_LIMIT = 500
const MAX_SYMBOL_FILES = 20
/** Workspace symbols are a bonus; a slow server must not hold up the menu. */
const SYMBOL_TIMEOUT_MS = 1_500
const FIND_TIMEOUT_MS = 5_000
/** Characters of the query turned into the fuzzy glob. */
const MAX_TERM_CHARS = 40
const MAX_EXCLUDE_PATTERNS = 300
/** A query worth asking the language servers about: an identifier of three characters or more. */
const IDENTIFIER = /^[A-Za-z_$][\w$]{2,}$/
/**
 * Declarations a mention is likely after; locals, fields and methods only add
 * noise. Read when called: the hosts that load this module without VS Code
 * (tests, the standalone build) have no `SymbolKind`.
 */
function isDeclarationKind(kind: vscode.SymbolKind): boolean {
	const kinds = vscode.SymbolKind
	return [
		kinds.Class,
		kinds.Interface,
		kinds.Function,
		kinds.Enum,
		kinds.Struct,
		kinds.Module,
		kinds.Namespace,
		kinds.Constant,
	].includes(kind)
}

const FILE = SearchWorkspaceItemsRequest_SearchItemType.FILE
const FOLDER = SearchWorkspaceItemsRequest_SearchItemType.FOLDER

type SearchItem = SearchWorkspaceItemsResponse_SearchItem

export async function searchWorkspaceItems(request: SearchWorkspaceItemsRequest): Promise<SearchWorkspaceItemsResponse> {
	const { folder, base } = resolveRoot(request.workspacePath)
	const limit = Math.min(Math.max(request.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
	const wantFiles = request.selectedType !== FOLDER
	const wantFolders = request.selectedType !== FILE
	const exclude = excludeGlob(folder.uri)
	const query = request.query.trim()
	const term = globTerm(query)
	const relative = (uri: vscode.Uri) => path.relative(base, uri.fsPath)
	const items = new Map<string, SearchItem>()
	const add = (item: SearchItem) => {
		if (item.path && !items.has(item.path)) {
			items.set(item.path, item)
		}
	}

	if (!term) {
		// No query: the caller shows the first files it gets (after the open tabs).
		const files = await findFiles(base, "**/*", exclude, limit)
		if (wantFiles) {
			for (const uri of files) {
				add(fileItem(relative(uri)))
			}
		} else {
			for (const folderPath of ancestorFolders(files.map(relative))) {
				add(folderItem(folderPath))
			}
		}
		return SearchWorkspaceItemsResponse.create({ items: [...items.values()] })
	}

	const glob = fuzzyGlob(term)
	const [symbolFiles, nameMatches, folderMatches] = await Promise.all([
		wantFiles && IDENTIFIER.test(query) ? symbolItems(query, base) : Promise.resolve([]),
		wantFiles ? findFiles(base, `**/${glob}`, exclude, limit) : Promise.resolve([]),
		wantFolders ? findFiles(base, `**/${glob}/**`, exclude, FOLDER_PASS_LIMIT) : Promise.resolve([]),
	])
	for (const item of symbolFiles) {
		add(item)
	}
	for (const uri of nameMatches) {
		add(fileItem(relative(uri)))
	}
	const matcher = fuzzyRegExp(term)
	for (const folderPath of ancestorFolders(folderMatches.map(relative))) {
		if (matcher.test(path.basename(folderPath))) {
			add(folderItem(folderPath))
		}
	}
	if (wantFiles && nameMatches.length < SPARSE_RESULTS) {
		for (const uri of await findFiles(base, "**/*", exclude, limit)) {
			add(fileItem(relative(uri)))
		}
	}
	return SearchWorkspaceItemsResponse.create({ items: [...items.values()].slice(0, limit) })
}

/**
 * The workspace folder the search runs in, and the directory paths are relative
 * to. Throws when the directory is in no open folder: findFiles only searches
 * those, so ripgrep has to.
 */
function resolveRoot(workspacePath: string | undefined): { folder: vscode.WorkspaceFolder; base: string } {
	const folders = vscode.workspace.workspaceFolders ?? []
	if (!workspacePath) {
		const folder = folders.find((candidate) => candidate.uri.scheme === "file")
		if (!folder) {
			throw cannotServe("The window has no workspace folder on disk to search")
		}
		return { folder, base: folder.uri.fsPath }
	}
	const folder = folders.find((candidate) => candidate.uri.scheme === "file" && isInside(candidate.uri.fsPath, workspacePath))
	if (!folder) {
		throw cannotServe(`${workspacePath} is not in a workspace folder of this window`)
	}
	return { folder, base: workspacePath }
}

/**
 * An error carrying gRPC's UNIMPLEMENTED code, which the caller takes as "this
 * host cannot serve the search" and answers with ripgrep without a warning:
 * a conversation in a worktree outside the window's folders hits it on every
 * keystroke.
 */
function cannotServe(message: string): Error {
	return Object.assign(new Error(message), { code: 12 })
}

function isInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child)
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** findFiles under `base`, cancelled after a few seconds. Throws when it found nothing in time. */
async function findFiles(base: string, include: string, exclude: string | undefined, maxResults: number): Promise<vscode.Uri[]> {
	const cancellation = new vscode.CancellationTokenSource()
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		cancellation.cancel()
	}, FIND_TIMEOUT_MS)
	try {
		const uris = await vscode.workspace.findFiles(
			new vscode.RelativePattern(base, include),
			exclude,
			maxResults,
			cancellation.token,
		)
		if (timedOut && uris.length === 0) {
			throw new Error(`findFiles timed out after ${FIND_TIMEOUT_MS} ms`)
		}
		return uris.filter((uri) => uri.scheme === "file")
	} finally {
		clearTimeout(timer)
		cancellation.dispose()
	}
}

/**
 * The files declaring workspace symbols whose names contain the query, each
 * labelled with its path and the symbol so the caller's fzf, which matches on
 * the label, keeps it even when the file name has nothing of the query in it.
 */
async function symbolItems(query: string, base: string): Promise<SearchItem[]> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), SYMBOL_TIMEOUT_MS)
	})
	try {
		const symbols = await Promise.race([
			Promise.resolve(
				vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
					"vscode.executeWorkspaceSymbolProvider",
					query,
				),
			).catch(() => undefined),
			timeout,
		])
		const lowerQuery = query.toLowerCase()
		const items = new Map<string, SearchItem>()
		for (const symbol of symbols ?? []) {
			const uri = symbol.location?.uri
			if (
				!uri ||
				uri.scheme !== "file" ||
				!isDeclarationKind(symbol.kind) ||
				!symbol.name.toLowerCase().includes(lowerQuery) ||
				!isInside(base, uri.fsPath)
			) {
				continue
			}
			const relativePath = path.relative(base, uri.fsPath)
			if (!items.has(relativePath)) {
				items.set(relativePath, {
					path: relativePath,
					type: FILE,
					label: `${relativePath.split(path.sep).join("/")} (${symbol.name})`,
				})
			}
			if (items.size >= MAX_SYMBOL_FILES) {
				break
			}
		}
		return [...items.values()]
	} finally {
		clearTimeout(timer)
	}
}

function fileItem(relativePath: string): SearchItem {
	return { path: relativePath, type: FILE, label: path.basename(relativePath) }
}

function folderItem(relativePath: string): SearchItem {
	return { path: relativePath, type: FOLDER, label: path.basename(relativePath) }
}

/** Every directory above the files, relative paths, without duplicates. */
function ancestorFolders(relativePaths: readonly string[]): string[] {
	const folders = new Set<string>()
	for (const relativePath of relativePaths) {
		let folder = path.dirname(relativePath)
		while (folder && folder !== "." && folder !== path.sep && !folders.has(folder)) {
			folders.add(folder)
			folder = path.dirname(folder)
		}
	}
	return [...folders]
}

/**
 * The part of the query a file or folder name has to match: the text after its
 * last path separator, without spaces and glob syntax.
 */
function globTerm(query: string): string {
	const last = query.split(/[\\/]/).pop() ?? ""
	return last.replace(/[\s*?[\]{}!,]/g, "").slice(0, MAX_TERM_CHARS)
}

/** `chrow` → `*[cC]*[hH]*[rR]*[oO]*[wW]*`: the characters in order, any case. */
function fuzzyGlob(term: string): string {
	const parts = [...term].map((char) => {
		const lower = char.toLowerCase()
		const upper = char.toUpperCase()
		return lower === upper ? char : `[${lower}${upper}]`
	})
	return `*${parts.join("*")}*`
}

/** The same match as `fuzzyGlob`, for a name already in hand. */
function fuzzyRegExp(term: string): RegExp {
	const escaped = [...term].map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
	return new RegExp(escaped.join(".*"), "i")
}

/**
 * `files.exclude` and `search.exclude` as one glob. Entries with a `when`
 * condition are left out (they need the sibling files to evaluate), and brace
 * groups are expanded, since a brace group cannot nest inside the one that
 * joins the patterns.
 */
function excludeGlob(scope: vscode.Uri): string | undefined {
	const patterns = new Set<string>()
	for (const section of ["files", "search"]) {
		let entries: Record<string, unknown> | undefined
		try {
			entries = vscode.workspace.getConfiguration(section, scope).get<Record<string, unknown>>("exclude")
		} catch {
			entries = undefined
		}
		for (const [pattern, value] of Object.entries(entries ?? {})) {
			if (value === true) {
				for (const expanded of expandBraces(pattern)) {
					patterns.add(expanded)
				}
			}
		}
	}
	const list = [...patterns].slice(0, MAX_EXCLUDE_PATTERNS)
	if (list.length === 0) {
		return undefined
	}
	return list.length === 1 ? list[0] : `{${list.join(",")}}`
}

/** `**\/{a,b}/x` → `**\/a/x`, `**\/b/x`; nested groups too, at most 50 results. */
function expandBraces(pattern: string): string[] {
	const open = pattern.indexOf("{")
	if (open < 0) {
		return [pattern]
	}
	let depth = 0
	let close = -1
	const commas: number[] = []
	for (let index = open; index < pattern.length; index++) {
		const char = pattern[index]
		if (char === "{") {
			depth++
		} else if (char === "}") {
			depth--
			if (depth === 0) {
				close = index
				break
			}
		} else if (char === "," && depth === 1) {
			commas.push(index)
		}
	}
	if (close < 0) {
		return [pattern.replace(/[{}]/g, "")]
	}
	const prefix = pattern.slice(0, open)
	const suffix = pattern.slice(close + 1)
	const bounds = [open, ...commas, close]
	const results: string[] = []
	for (let index = 0; index < bounds.length - 1 && results.length < 50; index++) {
		const alternative = pattern.slice(bounds[index] + 1, bounds[index + 1])
		results.push(...expandBraces(`${prefix}${alternative}${suffix}`))
	}
	return results.slice(0, 50)
}
