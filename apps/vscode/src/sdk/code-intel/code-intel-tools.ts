/**
 * `find_symbol` and `code_navigate`: the window's language servers, offered to
 * the model as two small tools.
 *
 * Without them the agent finds code by regex (`search_codebase`), which costs
 * several calls per question and misleads the weaker free models: a search for
 * `foo` returns every `foo` in comments and strings, and nothing tells the
 * model which hit is the definition. The language servers VS Code already runs
 * know. `find_symbol` answers "what is there" (an outline, or the symbols
 * matching a name across the workspace) and `code_navigate` answers "where is
 * this defined, who uses it, what is its type" for a symbol named in a file.
 *
 * Two tools, not six, because free models mis-fill wide schemas; one `action`
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
import {
	displayPath,
	formatLocations,
	formatOutline,
	formatWorkspaceSymbols,
	type LocatedResult,
	locateSymbol,
	MAX_RESULT_LINES,
	trimPreview,
} from "./code-intel-format"
import type { CodeIntelSource, CodeLocation } from "./code-intel-source"

const FIND_SYMBOL_TOOL_NAME = "find_symbol"
const CODE_NAVIGATE_TOOL_NAME = "code_navigate"

const NAVIGATE_ACTIONS = ["definition", "references", "hover"] as const
type NavigateAction = (typeof NAVIGATE_ACTIONS)[number]

/** How long to give a language server that answered nothing before asking once more. */
const DEFAULT_WARMUP_MS = 1_500
/** Empty answers for a file extension after which the warm-up retry is skipped. */
const SILENT_CALLS_BEFORE_SKIP = 2
const TOOL_TIMEOUT_MS = 20_000

interface CodeIntelToolsOptions {
	cwd: string
	source: CodeIntelSource
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

/** Both tools, sharing one memory of which file extensions ever got an answer. */
export function createCodeIntelTools(options: CodeIntelToolsOptions): AgentTool[] {
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

	async function withPreviews(locations: readonly CodeLocation[], limit: number): Promise<LocatedResult[]> {
		const previews = await Promise.all(
			locations.slice(0, limit).map((location) => source.readLine(location.path, location.line).catch(() => undefined)),
		)
		return locations.map((location, index) => ({
			...location,
			preview: index < previews.length ? trimPreview(previews[index]) || undefined : undefined,
		}))
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

	const codeNavigate: AgentTool = {
		name: CODE_NAVIGATE_TOOL_NAME,
		description:
			"Ask the editor's language server about a symbol that appears in a file: `definition` (where it is declared), " +
			"`references` (every use, grouped by file) or `hover` (its type or signature and doc comment). Name the file " +
			"and the symbol as written there; add `line` when the name occurs several times. Use this instead of " +
			"search_codebase to find a declaration or the callers of a function.",
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: [...NAVIGATE_ACTIONS], description: "What to look up." },
				path: { type: "string", description: "File in which the symbol appears." },
				symbol: { type: "string", description: "The identifier, as written in that file." },
				line: { type: "number", description: "Line of the occurrence to use, when the name appears more than once." },
			},
			required: ["action", "path", "symbol"],
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
			const symbol = (input.symbol ?? "").trim()
			if (!input.path || !symbol) {
				throw new Error("code_navigate needs `path` (a file) and `symbol` (an identifier that appears in it).")
			}
			const absolutePath = resolvePath(input.path)
			const text = await source.readDocument(absolutePath)
			if (text === undefined) {
				throw new Error(`Cannot open ${displayPath(absolutePath, cwd)}.`)
			}
			const position = locateSymbol(text, symbol, input.line)
			if (!position) {
				throw new Error(
					`\`${symbol}\` does not appear as an identifier in ${displayPath(absolutePath, cwd)}. ` +
						"Check the spelling, or use find_symbol to locate it.",
				)
			}
			const at = `${displayPath(absolutePath, cwd)}:${position.line}:${position.column}`
			const signal = context.signal
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
						`${locations.length} reference${locations.length === 1 ? "" : "s"} to \`${symbol}\` in ${files} file${files === 1 ? "" : "s"} (looked up at ${at}):`,
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
			}
		},
	}

	Logger.log(`[CodeIntel] Prepared ${FIND_SYMBOL_TOOL_NAME} and ${CODE_NAVIGATE_TOOL_NAME} for ${cwd}`)
	return [findSymbol, codeNavigate]
}
