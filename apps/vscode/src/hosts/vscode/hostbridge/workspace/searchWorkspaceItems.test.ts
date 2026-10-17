import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

interface FindFilesCall {
	base: string
	pattern: string
	exclude: string | undefined
	maxResults: number
}

const state = vi.hoisted(() => ({
	folders: [] as { uri: { scheme: string; fsPath: string } }[],
	files: [] as string[],
	config: {} as Record<string, Record<string, unknown> | undefined>,
	symbols: [] as unknown[],
	calls: [] as FindFilesCall[],
	symbolQueries: [] as string[],
	/** When set, findFiles answers only once cancelled, and then with nothing. */
	hang: false,
}))

vi.mock("vscode", () => {
	class RelativePattern {
		constructor(
			public base: string,
			public pattern: string,
		) {}
	}
	class CancellationTokenSource {
		private listeners: (() => void)[] = []
		token = {
			isCancellationRequested: false,
			onCancellationRequested: (listener: () => void) => {
				this.listeners.push(listener)
			},
		}
		cancel() {
			this.token.isCancellationRequested = true
			for (const listener of this.listeners) {
				listener()
			}
		}
		dispose() {}
	}
	return {
		SymbolKind: {
			Module: 1,
			Namespace: 2,
			Class: 4,
			Method: 5,
			Enum: 9,
			Interface: 10,
			Function: 11,
			Variable: 12,
			Constant: 13,
			Struct: 22,
		},
		RelativePattern,
		CancellationTokenSource,
		workspace: {
			get workspaceFolders() {
				return state.folders
			},
			getConfiguration: (section: string) => ({ get: () => state.config[section] }),
			findFiles: (
				include: { base: string; pattern: string },
				exclude: string | undefined,
				maxResults: number,
				token: CancellationTokenSource["token"],
			) => {
				state.calls.push({ base: include.base, pattern: include.pattern, exclude, maxResults })
				if (state.hang) {
					return new Promise((resolve) => token.onCancellationRequested(() => resolve([])))
				}
				const matcher = globToRegExp(include.pattern)
				return Promise.resolve(
					state.files
						.filter((file) => matcher.test(path.relative(include.base, file).split(path.sep).join("/")))
						.slice(0, maxResults)
						.map((file) => ({ scheme: "file", fsPath: file })),
				)
			},
		},
		commands: {
			executeCommand: async (command: string, query: string) => {
				expect(command).toBe("vscode.executeWorkspaceSymbolProvider")
				state.symbolQueries.push(query)
				return state.symbols
			},
		},
	}

	/** The glob subset the search sends: `**\/`, `/**`, `*` and `[aA]` classes. */
	function globToRegExp(glob: string): RegExp {
		let source = ""
		for (let index = 0; index < glob.length; index++) {
			if (glob.startsWith("**/", index)) {
				source += "(?:.*/)?"
				index += 2
			} else if (glob.startsWith("/**", index)) {
				source += "/.*"
				index += 2
			} else if (glob[index] === "*") {
				source += "[^/]*"
			} else if (glob[index] === "[") {
				const close = glob.indexOf("]", index)
				source += glob.slice(index, close + 1)
				index = close
			} else {
				source += glob[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			}
		}
		return new RegExp(`^${source}$`)
	}
})

import { SearchWorkspaceItemsRequest_SearchItemType } from "@/shared/proto/host/workspace"
import { searchWorkspaceItems } from "./searchWorkspaceItems"

const FILE = SearchWorkspaceItemsRequest_SearchItemType.FILE
const FOLDER = SearchWorkspaceItemsRequest_SearchItemType.FOLDER
const ROOT = path.resolve("/ws")
const at = (...segments: string[]) => path.join(ROOT, ...segments)
const rel = (...segments: string[]) => path.join(...segments)
const uri = (fsPath: string) => ({ scheme: "file", fsPath })

describe("searchWorkspaceItems", () => {
	beforeEach(() => {
		state.folders = [{ uri: uri(ROOT) }]
		state.files = []
		state.config = {}
		state.symbols = []
		state.calls = []
		state.symbolQueries = []
		state.hang = false
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("returns the files whose names fuzzy-match, files declaring matching symbols first, then a listing to rank", async () => {
		state.files = [
			at("src", "chat", "ChatRow.tsx"),
			at("src", "chat", "ChatView.tsx"),
			at("src", "rows", "chat-row-utils.ts"),
			at("docs", "readme.md"),
		]
		state.symbols = [
			{ name: "ChatRowProps", kind: 10, location: { uri: uri(at("src", "types.ts")) } },
			{ name: "chatRowLocal", kind: 12, location: { uri: uri(at("src", "a.ts")) } },
			{ name: "ChatRow", kind: 11, location: { uri: uri(path.resolve("/elsewhere/ChatRow.tsx")) } },
			{ name: "Other", kind: 4, location: { uri: uri(at("src", "b.ts")) } },
		]

		const response = await searchWorkspaceItems({ query: "chatrow", workspacePath: ROOT, limit: 5000 })

		expect(state.symbolQueries).toEqual(["chatrow"])
		expect(state.calls.map((call) => [call.pattern, call.maxResults])).toEqual([
			["**/*[cC]*[hH]*[aA]*[tT]*[rR]*[oO]*[wW]*", 5000],
			["**/*[cC]*[hH]*[aA]*[tT]*[rR]*[oO]*[wW]*/**", 500],
			// Two name matches are too few for fzf to rank: the plain listing tops them up.
			["**/*", 5000],
		])
		expect(state.calls.every((call) => call.base === ROOT)).toBe(true)
		expect(response.items).toEqual([
			{ path: rel("src", "types.ts"), type: FILE, label: "src/types.ts (ChatRowProps)" },
			{ path: rel("src", "chat", "ChatRow.tsx"), type: FILE, label: "ChatRow.tsx" },
			{ path: rel("src", "rows", "chat-row-utils.ts"), type: FILE, label: "chat-row-utils.ts" },
			{ path: rel("src", "chat", "ChatView.tsx"), type: FILE, label: "ChatView.tsx" },
			{ path: rel("docs", "readme.md"), type: FILE, label: "readme.md" },
		])
	})

	it("applies files.exclude and search.exclude as one glob, expanding brace groups and skipping `when` entries", async () => {
		state.config = {
			files: { "**/.git": true, "**/*.js": { when: "$(basename).ts" }, "**/off": false },
			search: { "**/{node_modules,dist}": true, "**/.git": true },
		}
		await searchWorkspaceItems({ query: "", workspacePath: ROOT })
		expect(state.calls[0].exclude).toBe("{**/.git,**/node_modules,**/dist}")

		state.calls = []
		state.config = { search: { "**/node_modules": true } }
		await searchWorkspaceItems({ query: "", workspacePath: ROOT })
		expect(state.calls[0].exclude).toBe("**/node_modules")
	})

	it("finds folders by name, and asks no language server for a folder", async () => {
		state.files = [at("src", "components", "a.ts"), at("src", "components", "sub", "b.ts"), at("src", "compiler.ts")]

		const response = await searchWorkspaceItems({ query: "src/comp", workspacePath: ROOT, selectedType: FOLDER })

		expect(state.calls.map((call) => call.pattern)).toEqual(["**/*[cC]*[oO]*[mM]*[pP]*/**"])
		expect(state.symbolQueries).toEqual([])
		expect(response.items).toEqual([{ path: rel("src", "components"), type: FOLDER, label: "components" }])
	})

	it("lists files, or their folders, when there is no query", async () => {
		state.files = [at("src", "a.ts"), at("src", "lib", "b.ts"), at("c.ts")]

		const files = await searchWorkspaceItems({ query: "  ", workspacePath: ROOT, limit: 2 })
		expect(state.calls).toEqual([{ base: ROOT, pattern: "**/*", exclude: undefined, maxResults: 2 }])
		expect(files.items).toEqual([
			{ path: rel("src", "a.ts"), type: FILE, label: "a.ts" },
			{ path: rel("src", "lib", "b.ts"), type: FILE, label: "b.ts" },
		])

		const folders = await searchWorkspaceItems({ query: "", workspacePath: ROOT, selectedType: FOLDER })
		expect(folders.items).toEqual([
			{ path: "src", type: FOLDER, label: "src" },
			{ path: rel("src", "lib"), type: FOLDER, label: "lib" },
		])
		expect(state.symbolQueries).toEqual([])
	})

	it("searches a subfolder of an open folder, relative to that subfolder", async () => {
		state.files = [at("packages", "app", "src", "main.ts")]
		const base = at("packages", "app")

		const response = await searchWorkspaceItems({ query: "main", workspacePath: base })

		expect(state.calls[0]).toMatchObject({ base, pattern: "**/*[mM]*[aA]*[iI]*[nN]*" })
		expect(response.items[0]).toEqual({ path: rel("src", "main.ts"), type: FILE, label: "main.ts" })
	})

	it("hands a directory outside the window's folders back to ripgrep as unimplemented", async () => {
		await expect(searchWorkspaceItems({ query: "x", workspacePath: path.resolve("/worktrees/wt") })).rejects.toMatchObject({
			code: 12,
		})
		state.folders = []
		await expect(searchWorkspaceItems({ query: "x" })).rejects.toMatchObject({ code: 12 })
		expect(state.calls).toEqual([])
	})

	it("fails, so the caller uses ripgrep, when the index finds nothing before its timeout", async () => {
		vi.useFakeTimers()
		state.hang = true
		const search = searchWorkspaceItems({ query: "", workspacePath: ROOT })
		const assertion = expect(search).rejects.toThrow("findFiles timed out")
		await vi.advanceTimersByTimeAsync(5_000)
		await assertion
	})
})
