/**
 * `find_symbol`, `code_navigate`, `rename_preview` and `rename_symbol`: the
 * window's language servers, offered to the model as four small tools.
 *
 * Without them the agent finds code by regex (`search_codebase`), which costs
 * several calls per question and misleads the weaker free models: a search for
 * `foo` returns every `foo` in comments and strings, and nothing tells the
 * model which hit is the definition. The language servers VS Code already runs
 * know. `find_symbol` answers "what is there" (an outline, or the symbols
 * matching a name across the workspace), `code_navigate` answers "where is
 * this defined, who uses or calls it, what does it call, what is its type" for
 * a symbol named in a file and "what is wrong with this file, or with the
 * workspace", `rename_preview` shows the reach of a rename without applying it,
 * and `rename_symbol` applies it.
 *
 * Few tools, not ten, because free models mis-fill wide schemas; one `action`
 * argument is cheaper in schema tokens and in mistakes. The model names a
 * symbol and a file, never a column: `locateSymbol` finds the position.
 *
 * VS Code does not say whether a language server is registered for a file, so
 * an empty answer gets one retry after a short warm-up (a server that has just
 * loaded the file may not have indexed it yet) and then a fallback line that
 * sends the model to `search_codebase`. File extensions that keep answering
 * nothing stop being waited for.
 */

import type { AgentTool, AgentToolContext } from "@plinycode/shared"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import type { EditedFile, EditProblemCheck } from "../edit-problems"
import {
	applyLineEdits,
	countOf,
	displayPath,
	formatCalls,
	formatDiagnostics,
	formatLocations,
	formatOutline,
	formatRenamePreview,
	formatWorkspaceErrors,
	formatWorkspaceSymbols,
	groupEditsByLine,
	type LocatedCall,
	type LocatedResult,
	locateSymbol,
	MAX_CALL_LINES,
	MAX_RENAME_FILES,
	MAX_RENAME_LINES_PER_FILE,
	MAX_RESULT_LINES,
	type RenameFilePreview,
	trimPreview,
} from "./code-intel-format"
import type { CodeCall, CodeIntelSource, CodeLocation, CodeRenameResult, CodeTextEdit } from "./code-intel-source"

const FIND_SYMBOL_TOOL_NAME = "find_symbol"
const CODE_NAVIGATE_TOOL_NAME = "code_navigate"
const RENAME_PREVIEW_TOOL_NAME = "rename_preview"
const RENAME_SYMBOL_TOOL_NAME = "rename_symbol"

const NAVIGATE_ACTIONS = ["definition", "references", "hover", "callers", "callees", "diagnostics"] as const
type NavigateAction = (typeof NAVIGATE_ACTIONS)[number]

/** How long to give a language server that answered nothing before asking once more. */
const DEFAULT_WARMUP_MS = 1_500
/** Empty answers for a file extension after which the warm-up retry is skipped. */
const SILENT_CALLS_BEFORE_SKIP = 2
const TOOL_TIMEOUT_MS = 20_000
/**
 * A rename asks the server twice (preview, then apply), saves every file and
 * waits up to a few seconds for the new-problems check.
 */
const RENAME_SYMBOL_TIMEOUT_MS = 60_000
/** How long a rename approval waits for its summary before it is shown without one. */
const RENAME_APPROVAL_TIMEOUT_MS = 10_000

interface CodeIntelToolsOptions {
	cwd: string
	source: CodeIntelSource
	/**
	 * Whether to add `rename_symbol`, the one tool that writes. Off in plan and
	 * ask mode, where the engine's mode guards would reject it anyway.
	 * Defaults to on.
	 */
	allowEdits?: boolean
	/**
	 * Records the errors of the files a rename is about to edit, and of every
	 * other file, so its result can list the new ones (edit-problems.ts).
	 * Without it the result is the rename summary alone.
	 */
	beginEditCheck?: (files: EditedFile[], cwd: string) => EditProblemCheck | undefined
	warmupMs?: number
	/** Injectable for tests. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

interface FindSymbolInput {
	query?: string
	path?: string
}

interface CodeNavigateInput {
	action?: string
	path?: string
	symbol?: string
	line?: number
}

interface RenameInput {
	path?: string
	symbol?: string
	new_name?: string
	line?: number
}

/** A rename the server agreed to, ready to show or apply. */
interface RenamePlan {
	ok: true
	symbol: string
	newName: string
	absolutePath: string
	position: { line: number; column: number }
	/** `path:line:col` of the occurrence the rename was asked at. */
	at: string
	/** The files with at least one edit. */
	files: { path: string; edits: CodeTextEdit[] }[]
	edits: number
	/** The first files and lines, as they read before and after the rename. */
	previews: RenameFilePreview[]
}

/** The server refused the rename or did not answer; the message says which. */
interface RenameRefusal {
	ok: false
	message: string
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve()
			return
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort)
			resolve()
		}, ms)
		function onAbort() {
			clearTimeout(timer)
			resolve()
		}
		signal?.addEventListener("abort", onAbort, { once: true })
	})
}

/**
 * What every tool needs: path resolution, the warm-up retry with its memory of
 * which file extensions ever got an answer, and the rename planner that both
 * rename tools and the rename approval share.
 */
function createCodeIntelContext(options: CodeIntelToolsOptions) {
	const { cwd, source } = options
	const warmupMs = options.warmupMs ?? DEFAULT_WARMUP_MS
	const sleep = options.sleep ?? defaultSleep
	const answeredExtensions = new Set<string>()
	const silentCalls = new Map<string, number>()

	const resolvePath = (input: string): string => (path.isAbsolute(input) ? input : path.resolve(cwd, input))

	/**
	 * Runs a language-server query, retrying once after the warm-up when the
	 * first answer is empty and the file's extension is not known to be silent.
	 */
	async function withWarmup<T>(
		absolutePath: string,
		query: () => Promise<T[] | undefined>,
		signal?: AbortSignal,
	): Promise<T[]> {
		const extension = path.extname(absolutePath).toLowerCase() || "(none)"
		const first = (await query()) ?? []
		if (first.length > 0) {
			answeredExtensions.add(extension)
			silentCalls.delete(extension)
			return first
		}
		const silent = silentCalls.get(extension) ?? 0
		if (!answeredExtensions.has(extension) && silent >= SILENT_CALLS_BEFORE_SKIP) {
			return first
		}
		await sleep(warmupMs, signal)
		if (signal?.aborted) {
			return first
		}
		const second = (await query()) ?? []
		if (second.length > 0) {
			answeredExtensions.add(extension)
			silentCalls.delete(extension)
		} else if (!answeredExtensions.has(extension)) {
			silentCalls.set(extension, silent + 1)
		}
		return second
	}

	function noAnswer(absolutePath: string, what: string): string {
		const extension = path.extname(absolutePath) || "this kind of"
		return (
			`${what} No language server answered for ${extension} files in ${displayPath(absolutePath, cwd)}, ` +
			"or it found nothing. Fall back to search_codebase for a text search."
		)
	}

	/** Opens the file and finds the symbol in it; throws a message the model can act on when either fails. */
	async function openAndLocate(inputPath: string, symbol: string, line: number | undefined) {
		const absolutePath = resolvePath(inputPath)
		const text = await source.readDocument(absolutePath)
		if (text === undefined) {
			throw new Error(`Cannot open ${displayPath(absolutePath, cwd)}.`)
		}
		const position = locateSymbol(text, symbol, line)
		if (!position) {
			throw new Error(
				`\`${symbol}\` does not appear as an identifier in ${displayPath(absolutePath, cwd)}. ` +
					"Check the spelling, or use find_symbol to locate it.",
			)
		}
		const at = `${displayPath(absolutePath, cwd)}:${position.line}:${position.column}`
		return { absolutePath, position, at }
	}

	async function renamePreviews(result: CodeRenameResult): Promise<RenameFilePreview[]> {
		return Promise.all(
			result.files.slice(0, MAX_RENAME_FILES).map(async (file) => {
				const byLine = groupEditsByLine(file.edits)
				const shown = [...byLine.keys()].slice(0, MAX_RENAME_LINES_PER_FILE)
				const lines = await Promise.all(
					shown.map(async (line) => {
						const text = (await source.readLine(file.path, line).catch(() => undefined)) ?? ""
						return {
							line,
							before: trimPreview(text),
							after: trimPreview(applyLineEdits(text, byLine.get(line) ?? [])),
						}
					}),
				)
				return { path: file.path, edits: file.edits.length, changedLines: byLine.size, lines }
			}),
		)
	}

	/**
	 * Checks a rename's arguments, finds the symbol and asks the server for the
	 * edits. Throws on bad arguments; a refusal or an empty answer comes back
	 * as a `RenameRefusal`.
	 */
	async function planRename(rawInput: unknown, toolName: string, signal?: AbortSignal): Promise<RenamePlan | RenameRefusal> {
		const input = (rawInput ?? {}) as RenameInput
		const symbol = (input.symbol ?? "").trim()
		const newName = (input.new_name ?? "").trim()
		if (!input.path || !symbol || !newName) {
			throw new Error(
				`${toolName} needs \`path\` (a file), \`symbol\` (an identifier that appears in it) and \`new_name\`.`,
			)
		}
		if (newName === symbol || newName === symbol.slice(symbol.lastIndexOf(".") + 1)) {
			throw new Error(`${toolName}: \`new_name\` is the current name of \`${symbol}\`.`)
		}
		const { absolutePath, position, at } = await openAndLocate(input.path, symbol, input.line)
		const latest: { result?: CodeRenameResult } = {}
		const answers = await withWarmup(
			absolutePath,
			async () => {
				latest.result = await source.renameEdits(absolutePath, position.line, position.column, newName)
				return latest.result?.files.some((file) => file.edits.length > 0) ? [latest.result] : []
			},
			signal,
		)
		const result = answers[0]
		if (!result) {
			if (latest.result?.refusal) {
				return { ok: false, message: `Cannot rename \`${symbol}\` at ${at}: ${latest.result.refusal}` }
			}
			return { ok: false, message: noAnswer(absolutePath, `No rename edits for \`${symbol}\` (looked up at ${at}).`) }
		}
		const files = result.files.filter((file) => file.edits.length > 0)
		const edits = files.reduce((total, file) => total + file.edits.length, 0)
		const previews = await renamePreviews({ files })
		return { ok: true, symbol, newName, absolutePath, position, at, files, edits, previews }
	}

	return { cwd, source, sleep, warmupMs, resolvePath, withWarmup, noAnswer, openAndLocate, planRename }
}

/**
 * The summary shown in `rename_symbol`'s approval: the edits `rename_preview`
 * would list, worked out for the approval since the engine shows it before the
 * tool runs. Undefined when the arguments are unusable (the tool then reports
 * the problem itself) or the server takes longer than `timeoutMs`, so a slow
 * server delays the ask by that much at most.
 */
export async function describeRenameForApproval(
	options: Pick<CodeIntelToolsOptions, "cwd" | "source" | "warmupMs" | "sleep"> & { timeoutMs?: number },
	input: unknown,
): Promise<string | undefined> {
	const abort = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => {
			abort.abort()
			resolve(undefined)
		}, options.timeoutMs ?? RENAME_APPROVAL_TIMEOUT_MS)
	})
	const describe = async (): Promise<string | undefined> => {
		const plan = await createCodeIntelContext(options).planRename(input, RENAME_SYMBOL_TOOL_NAME, abort.signal)
		if (!plan.ok) {
			return plan.message
		}
		return [
			`Renaming \`${plan.symbol}\` to \`${plan.newName}\` (at ${plan.at}) will make ${countOf(plan.edits, "edit")} in ${countOf(plan.files.length, "file")} and save them.`,
			...formatRenamePreview(plan.previews, plan.files.length, options.cwd),
		].join("\n")
	}
	try {
		return await Promise.race([describe().catch(() => undefined), timeout])
	} finally {
		clearTimeout(timer)
	}
}

/** The tools, sharing one memory of which file extensions ever got an answer. */
export function createCodeIntelTools(options: CodeIntelToolsOptions): AgentTool[] {
	const intel = createCodeIntelContext(options)
	const { cwd, source, sleep, warmupMs, resolvePath, withWarmup, noAnswer, openAndLocate } = intel

	async function withPreviews<L extends CodeLocation>(locations: readonly L[], limit: number): Promise<(L & LocatedResult)[]> {
		const previews = await Promise.all(
			locations.slice(0, limit).map((location) => source.readLine(location.path, location.line).catch(() => undefined)),
		)
		return locations.map((location, index) => ({
			...location,
			preview: index < previews.length ? trimPreview(previews[index]) || undefined : undefined,
		}))
	}

	/**
	 * Callers are shown at their call site, so the preview is the line that
	 * makes the call; callees at their declaration, so it is their signature.
	 */
	function callEntry(call: CodeCall, direction: "callers" | "callees"): LocatedCall {
		const at = direction === "callers" && call.callSite ? call.callSite : call
		return { kind: call.kind, name: call.name, path: at.path, line: at.line, column: at.column }
	}

	const findSymbol: AgentTool = {
		name: FIND_SYMBOL_TOOL_NAME,
		description:
			"Look up symbols through the editor's language servers. With `path`, list the file's outline: every class, " +
			"function, method and variable with its line. Without it, find the symbols whose names match `query` across " +
			"the workspace, each with its file and line. Prefer this to search_codebase when you know a name and want its " +
			"declaration, or want to see what a file defines. Answers with a note when the file has no language server.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Symbol name, or part of one, to find across the workspace." },
				path: { type: "string", description: "A file whose outline to list; `query` then filters it." },
			},
		},
		executionMode: "parallel",
		retryable: false,
		timeoutMs: TOOL_TIMEOUT_MS,
		async execute(rawInput: unknown, context: AgentToolContext): Promise<string> {
			const input = (rawInput ?? {}) as FindSymbolInput
			const query = (input.query ?? "").trim()
			if (input.path) {
				const absolutePath = resolvePath(input.path)
				if ((await source.readDocument(absolutePath)) === undefined) {
					throw new Error(`Cannot open ${displayPath(absolutePath, cwd)}.`)
				}
				const symbols = await withWarmup(absolutePath, () => source.documentSymbols(absolutePath), context.signal)
				const filtered = query
					? symbols.filter((symbol) => symbol.name.toLowerCase().includes(query.toLowerCase()))
					: symbols
				if (filtered.length === 0) {
					return noAnswer(
						absolutePath,
						query ? `No symbol matching "${query}" in the outline.` : "No outline available.",
					)
				}
				const header = query
					? `${filtered.length} symbols matching "${query}" in ${displayPath(absolutePath, cwd)}:`
					: `Outline of ${displayPath(absolutePath, cwd)} (${filtered.length} symbols; kind name  line):`
				return [header, ...formatOutline(filtered)].join("\n")
			}
			if (!query) {
				throw new Error("find_symbol needs a `query` (a symbol name) or a `path` (a file whose outline to list).")
			}
			const symbols = (await source.workspaceSymbols(query)) ?? []
			if (symbols.length === 0) {
				return (
					`No workspace symbol matches "${query}". The language servers only index files they have loaded, ` +
					"so try find_symbol with the file's `path`, or search_codebase for a text search."
				)
			}
			return [`${symbols.length} symbols matching "${query}":`, ...formatWorkspaceSymbols(symbols, cwd)].join("\n")
		},
	}

	/**
	 * The file's errors and warnings. Diagnostics are not a query a server can
	 * answer late, so an empty list gets one warm-up wait (a file the editor
	 * has only just opened may not be analysed yet) without counting towards
	 * the extension's silence.
	 */
	async function fileDiagnostics(inputPath: string, signal?: AbortSignal): Promise<string> {
		const absolutePath = resolvePath(inputPath)
		const shown = displayPath(absolutePath, cwd)
		if ((await source.readDocument(absolutePath)) === undefined) {
			throw new Error(`Cannot open ${shown}.`)
		}
		let diagnostics = (await source.diagnostics(absolutePath)) ?? []
		if (diagnostics.length === 0) {
			await sleep(warmupMs, signal)
			if (!signal?.aborted) {
				diagnostics = (await source.diagnostics(absolutePath)) ?? []
			}
		}
		if (diagnostics.length === 0) {
			return `No errors or warnings reported for ${shown}. A file that no language server or linter checks reports none either.`
		}
		const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length
		return [
			`${countOf(errors, "error")} and ${countOf(diagnostics.length - errors, "warning")} in ${shown}:`,
			...formatDiagnostics(diagnostics),
		].join("\n")
	}

	/**
	 * The errors the editor reports across the window, grouped by file.
	 * Warnings are left out: across a workspace they drown the errors.
	 */
	async function workspaceDiagnostics(): Promise<string> {
		const files = ((await source.workspaceErrors()) ?? [])
			.map((file) => ({ ...file, diagnostics: file.diagnostics.filter((diagnostic) => diagnostic.severity === "error") }))
			.filter((file) => file.diagnostics.length > 0)
		if (files.length === 0) {
			return (
				"No errors reported in the workspace. The editor only reports errors for files its language servers and " +
				"linters have checked: the open files, and for some languages (TypeScript) the files of open projects. " +
				"Pass `path` to check one file."
			)
		}
		const errors = files.reduce((total, file) => total + file.diagnostics.length, 0)
		return [
			`${countOf(errors, "error")} in ${countOf(files.length, "file")} across the workspace (warnings left out):`,
			...formatWorkspaceErrors(files, cwd),
		].join("\n")
	}

	const codeNavigate: AgentTool = {
		name: CODE_NAVIGATE_TOOL_NAME,
		description:
			"Ask the editor's language server about a symbol that appears in a file: `definition` (where it is declared), " +
			"`references` (every use, grouped by file), `hover` (its type or signature and doc comment), `callers` (the " +
			"functions that call it) or `callees` (the functions it calls). Name the file and the symbol as written there; " +
			"add `line` when the name occurs several times. `diagnostics` needs no `symbol`: with `path` it lists the " +
			"file's errors and warnings, without `path` the errors across the workspace, grouped by file. Use this " +
			"instead of search_codebase to find a declaration or the callers of a function.",
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: [...NAVIGATE_ACTIONS], description: "What to look up." },
				path: {
					type: "string",
					description:
						"File in which the symbol appears, or whose problems to list. Needed by every action; " +
						"`diagnostics` without it lists the workspace's errors.",
				},
				symbol: {
					type: "string",
					description: "The identifier, as written in that file. Needed by every action except `diagnostics`.",
				},
				line: { type: "number", description: "Line of the occurrence to use, when the name appears more than once." },
			},
			required: ["action"],
		},
		executionMode: "parallel",
		retryable: false,
		timeoutMs: TOOL_TIMEOUT_MS,
		async execute(rawInput: unknown, context: AgentToolContext): Promise<string> {
			const input = (rawInput ?? {}) as CodeNavigateInput
			const action = (input.action ?? "").trim().toLowerCase() as NavigateAction
			if (!NAVIGATE_ACTIONS.includes(action)) {
				throw new Error(`code_navigate: action must be one of ${NAVIGATE_ACTIONS.join(", ")}.`)
			}
			const signal = context.signal
			const inputPath = (input.path ?? "").trim()
			if (action === "diagnostics") {
				return inputPath ? fileDiagnostics(inputPath, signal) : workspaceDiagnostics()
			}
			if (!inputPath) {
				throw new Error(`code_navigate needs \`path\` (the file in which the symbol appears) for \`${action}\`.`)
			}
			const symbol = (input.symbol ?? "").trim()
			if (!symbol) {
				throw new Error(`code_navigate needs \`symbol\` (an identifier that appears in the file) for \`${action}\`.`)
			}
			const { absolutePath, position, at } = await openAndLocate(inputPath, symbol, input.line)
			switch (action) {
				case "definition": {
					const locations = await withWarmup(
						absolutePath,
						() => source.definitions(absolutePath, position.line, position.column),
						signal,
					)
					if (locations.length === 0) {
						return noAnswer(absolutePath, `No definition found for \`${symbol}\` (looked up at ${at}).`)
					}
					const located = await withPreviews(locations, MAX_RESULT_LINES)
					return [`Definition of \`${symbol}\` (looked up at ${at}):`, ...formatLocations(located, cwd)].join("\n")
				}
				case "references": {
					const locations = await withWarmup(
						absolutePath,
						() => source.references(absolutePath, position.line, position.column),
						signal,
					)
					if (locations.length === 0) {
						return noAnswer(absolutePath, `No references found for \`${symbol}\` (looked up at ${at}).`)
					}
					const files = new Set(locations.map((location) => location.path)).size
					const located = await withPreviews(locations, MAX_RESULT_LINES)
					return [
						`${countOf(locations.length, "reference")} to \`${symbol}\` in ${countOf(files, "file")} (looked up at ${at}):`,
						...formatLocations(located, cwd),
					].join("\n")
				}
				case "hover": {
					const hovers = await withWarmup(
						absolutePath,
						async () => {
							const hover = await source.hover(absolutePath, position.line, position.column)
							return hover && (hover.signature.length > 0 || hover.documentation.length > 0) ? [hover] : []
						},
						signal,
					)
					const hover = hovers[0]
					if (!hover) {
						return noAnswer(absolutePath, `No type information for \`${symbol}\` (looked up at ${at}).`)
					}
					return [`\`${symbol}\` at ${at}:`, ...hover.signature, ...hover.documentation].join("\n")
				}
				case "callers":
				case "callees": {
					const direction = action === "callers" ? "incoming" : "outgoing"
					const hierarchies = await withWarmup(
						absolutePath,
						async () => {
							const hierarchy = await source.callHierarchy(absolutePath, position.line, position.column, direction)
							return hierarchy ? [hierarchy] : []
						},
						signal,
					)
					const hierarchy = hierarchies[0]
					if (!hierarchy) {
						return (
							`No call hierarchy for \`${symbol}\` (looked up at ${at}). Its language server may not offer one, ` +
							"or the symbol is not a function; try the `references` action, or search_codebase."
						)
					}
					if (hierarchy.calls.length === 0) {
						return action === "callers"
							? `No callers of \`${symbol}\` found (looked up at ${at}).`
							: `\`${symbol}\` calls no function the language server knows of (looked up at ${at}).`
					}
					const entries = hierarchy.calls.map((call) => callEntry(call, action))
					const located = await withPreviews(entries, MAX_CALL_LINES)
					const where = action === "callers" ? "each at its call site" : "each at its declaration"
					return [
						`${countOf(entries.length, action === "callers" ? "caller" : "callee")} of \`${symbol}\` (looked up at ${at}), ${where}:`,
						...formatCalls(located, cwd),
					].join("\n")
				}
			}
		},
	}

	const renameInputSchema = {
		type: "object",
		properties: {
			path: { type: "string", description: "File in which the symbol appears." },
			symbol: { type: "string", description: "The identifier to rename, as written in that file." },
			new_name: { type: "string", description: "The name it gets." },
			line: { type: "number", description: "Line of the occurrence to use, when the name appears more than once." },
		},
		required: ["path", "symbol", "new_name"],
	}

	const renamePreview: AgentTool = {
		name: RENAME_PREVIEW_TOOL_NAME,
		description:
			"Preview a rename through the editor's language server without changing anything: the edits that renaming " +
			"`symbol` (as written in `path`) to `new_name` would make, counted per file with the first changed lines. " +
			"Use it to see a rename's reach before making it with rename_symbol; it applies nothing. Add `line` when the " +
			"name occurs several times in the file. When the server refuses (the symbol cannot be renamed there), you " +
			"get its reason.",
		inputSchema: renameInputSchema,
		executionMode: "parallel",
		retryable: false,
		timeoutMs: TOOL_TIMEOUT_MS,
		async execute(rawInput: unknown, context: AgentToolContext): Promise<string> {
			const plan = await intel.planRename(rawInput, RENAME_PREVIEW_TOOL_NAME, context.signal)
			if (!plan.ok) {
				return plan.message
			}
			return [
				`Renaming \`${plan.symbol}\` to \`${plan.newName}\` (at ${plan.at}) would make ${countOf(plan.edits, "edit")} in ${countOf(plan.files.length, "file")}. Nothing was applied.`,
				...formatRenamePreview(plan.previews, plan.files.length, cwd),
			].join("\n")
		},
	}

	const renameSymbol: AgentTool = {
		name: RENAME_SYMBOL_TOOL_NAME,
		description:
			"Rename a symbol everywhere through the editor's language server: renames `symbol` (as written in `path`) " +
			"to `new_name` in its declaration and every use, across files, and saves them, once the user approves. " +
			"Use it instead of editing each use by hand; it changes code only, not comments or strings the server does " +
			"not count as uses. Add `line` when the name occurs several times in the file. The result lists the edits " +
			"per file and any new errors the editor reports afterwards. When the server refuses (the symbol cannot be " +
			"renamed there), nothing changes and you get its reason.",
		inputSchema: renameInputSchema,
		executionMode: "sequential",
		retryable: false,
		timeoutMs: RENAME_SYMBOL_TIMEOUT_MS,
		async execute(rawInput: unknown, context: AgentToolContext): Promise<string> {
			const signal = context.signal
			const plan = await intel.planRename(rawInput, RENAME_SYMBOL_TOOL_NAME, signal)
			if (!plan.ok) {
				throw new Error(`${plan.message} Nothing was changed.`)
			}
			if (signal?.aborted) {
				throw new Error(`The rename of \`${plan.symbol}\` was cancelled. Nothing was changed.`)
			}
			const editedFiles: EditedFile[] = plan.files.map((file) => ({
				absolutePath: file.path,
				displayPath: displayPath(file.path, cwd),
			}))
			const check = options.beginEditCheck?.(editedFiles, cwd)
			try {
				const applied = await source.applyRename(
					plan.absolutePath,
					plan.position.line,
					plan.position.column,
					plan.newName,
				)
				if (applied?.refusal) {
					throw new Error(`Cannot rename \`${plan.symbol}\` at ${plan.at}: ${applied.refusal} Nothing was changed.`)
				}
				const appliedFiles = applied?.files.filter((file) => file.edits.length > 0) ?? []
				if (!applied || appliedFiles.length === 0) {
					throw new Error(
						`The language server returned no edits when the rename of \`${plan.symbol}\` was applied. Nothing was changed.`,
					)
				}
				if (!applied.applied) {
					throw new Error(
						`The editor did not apply the rename of \`${plan.symbol}\` (a file may have changed or be read-only). ` +
							"Nothing was changed; read the files again and retry.",
					)
				}
				check?.written()
				const edits = appliedFiles.reduce((total, file) => total + file.edits.length, 0)
				const lines = [
					`Renamed \`${plan.symbol}\` to \`${plan.newName}\` (at ${plan.at}): ${countOf(edits, "edit")} in ${countOf(appliedFiles.length, "file")}, saved.`,
					...formatRenamePreview(plan.previews, plan.files.length, cwd),
				]
				if (applied.unsaved.length > 0) {
					lines.push(
						`Could not save ${applied.unsaved.map((file) => displayPath(file, cwd)).join(", ")}: the rename is in the editor only there.`,
					)
				}
				if (applied.hadUnsavedChanges.length > 0) {
					lines.push(
						`${applied.hadUnsavedChanges.map((file) => displayPath(file, cwd)).join(", ")} had unsaved changes in the editor, which were saved with the rename.`,
					)
				}
				const report = check ? await check.report(signal) : ""
				return lines.join("\n") + report
			} finally {
				check?.dispose()
			}
		},
	}

	const tools = [findSymbol, codeNavigate, renamePreview]
	if (options.allowEdits !== false) {
		tools.push(renameSymbol)
	}
	Logger.log(`[CodeIntel] Prepared ${tools.map((tool) => tool.name).join(", ")} for ${cwd}`)
	return tools
}
