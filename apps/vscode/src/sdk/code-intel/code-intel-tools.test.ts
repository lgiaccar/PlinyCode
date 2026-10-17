import type { AgentToolContext } from "@plinycode/shared"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import type { EditedFile, EditProblemCheck } from "../edit-problems"
import { formatLocations, locateSymbol, reduceHoverMarkdown } from "./code-intel-format"
import type {
	CodeCall,
	CodeDiagnostic,
	CodeFileDiagnostics,
	CodeIntelSource,
	CodeLocation,
	CodeRenameApplication,
	CodeSymbol,
	CodeTextEdit,
} from "./code-intel-source"
import { createCodeIntelTools, describeRenameForApproval } from "./code-intel-tools"

// Absolute in the platform's own form, so relative inputs resolve onto the fixtures on Windows too.
const CWD = path.resolve("/repo")
const A = path.join(CWD, "src", "a.ts")
const B = path.join(CWD, "src", "b.ts")

const FILES: Record<string, string> = {
	[A]: ["import { foo } from './b'", "", "export function useFoo() {", "\treturn foo(1) + foo(2)", "}"].join("\n"),
	[B]: ["/** Adds one. */", "export function foo(x: number): number {", "\treturn x + 1", "}"].join("\n"),
}

function context(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
	return { agentId: "a", iteration: 1, runId: "run-1", ...overrides }
}

function fakeSource(overrides: Partial<CodeIntelSource> = {}): CodeIntelSource & { calls: string[] } {
	const calls: string[] = []
	const record = <T>(name: string, value: T): T => {
		calls.push(name)
		return value
	}
	return {
		calls,
		readDocument: async (p) => record("readDocument", FILES[p]),
		readLine: async (p, line) => FILES[p]?.split("\n")[line - 1],
		documentSymbols: async () => record("documentSymbols", []),
		workspaceSymbols: async () => record("workspaceSymbols", []),
		definitions: async () => record("definitions", []),
		references: async () => record("references", []),
		hover: async () => record("hover", undefined),
		callHierarchy: async () => record("callHierarchy", undefined),
		diagnostics: async () => record("diagnostics", []),
		workspaceErrors: async () => record("workspaceErrors", []),
		renameEdits: async () => record("renameEdits", undefined),
		applyRename: async () => record("applyRename", undefined),
		...overrides,
	}
}

function tools(
	source: CodeIntelSource,
	sleep = vi.fn(async () => {}),
	extra: Partial<Parameters<typeof createCodeIntelTools>[0]> = {},
) {
	const [findSymbol, codeNavigate, renamePreview, renameSymbol] = createCodeIntelTools({
		cwd: CWD,
		source,
		warmupMs: 1,
		sleep,
		...extra,
	})
	return { findSymbol, codeNavigate, renamePreview, renameSymbol, sleep }
}

/** A one-line edit replacing `length` characters at the position. */
function edit(line: number, column: number, length: number, newText: string): CodeTextEdit {
	return { line, column, endLine: line, endColumn: column + length, newText }
}

describe("locateSymbol", () => {
	it("finds whole identifiers only, nearest to the preferred line", () => {
		const text = ["const food = 1", "foo()", "", "foo()"].join("\n")
		expect(locateSymbol(text, "foo")).toEqual({ line: 2, column: 1 })
		expect(locateSymbol(text, "foo", 4)).toEqual({ line: 4, column: 1 })
		expect(locateSymbol(text, "bar")).toBeUndefined()
	})

	it("tries a dotted name whole, then its last segment", () => {
		expect(locateSymbol("x = Foo.bar()", "Foo.bar")).toEqual({ line: 1, column: 5 })
		expect(locateSymbol("x = y.bar()", "Foo.bar")).toEqual({ line: 1, column: 7 })
	})
})

describe("reduceHoverMarkdown", () => {
	it("keeps fenced signatures and strips markdown from the prose", () => {
		const hover = reduceHoverMarkdown([
			"```typescript\nfunction foo(x: number): number\n```\n\n---\nAdds *one*.\n\n*@param* `x`",
		])
		expect(hover.signature).toEqual(["function foo(x: number): number"])
		expect(hover.documentation).toEqual(["Adds one.", "@param x"])
	})
})

describe("formatLocations", () => {
	it("groups by file and summarises the remainder", () => {
		const locations: CodeLocation[] = []
		for (let line = 1; line <= 10; line++) {
			locations.push({ path: A, line, column: 1 })
		}
		locations.push({ path: B, line: 1, column: 1 }, { path: B, line: 2, column: 1 })
		const lines = formatLocations(locations, CWD, 6)
		expect(lines[0]).toBe("src/a.ts")
		expect(lines).toHaveLength(7)
		expect(lines.at(-1)).toBe("+7 more in 2 files")
	})
})

describe("code_navigate", () => {
	it("resolves the symbol's position and shows the definition with a preview", async () => {
		const source = fakeSource({
			definitions: async (p, line, column) => {
				expect([p, line, column]).toEqual([A, 1, 10])
				return [{ path: B, line: 2, column: 17 }]
			},
		})
		const { codeNavigate } = tools(source)
		expect(codeNavigate.name).toBe("code_navigate")
		const result = await codeNavigate.execute({ action: "definition", path: "src/a.ts", symbol: "foo" }, context())
		expect(result).toBe(
			[
				"Definition of `foo` (looked up at src/a.ts:1:10):",
				"src/b.ts",
				"  2:17  export function foo(x: number): number {",
			].join("\n"),
		)
	})

	it("uses the occurrence nearest to `line` and counts references per file", async () => {
		const source = fakeSource({
			references: async (_p, line, column) => {
				// Line 4 has two occurrences; the first one on the nearest line wins.
				expect([line, column]).toEqual([4, 9])
				return [
					{ path: A, line: 1, column: 10 },
					{ path: A, line: 4, column: 9 },
					{ path: A, line: 4, column: 18 },
					{ path: B, line: 2, column: 17 },
				]
			},
		})
		const { codeNavigate } = tools(source)
		const result = await codeNavigate.execute({ action: "references", path: A, symbol: "foo", line: 4 }, context())
		expect(String(result).split("\n")[0]).toBe("4 references to `foo` in 2 files (looked up at src/a.ts:4:9):")
		expect(result).toContain("src/b.ts\n  2:17  export function foo")
	})

	it("reduces a hover to its signature and documentation", async () => {
		const source = fakeSource({
			hover: async () => ({ signature: ["function foo(x: number): number"], documentation: ["Adds one."] }),
		})
		const { codeNavigate } = tools(source)
		const result = await codeNavigate.execute({ action: "hover", path: A, symbol: "foo" }, context())
		expect(result).toBe(["`foo` at src/a.ts:1:10:", "function foo(x: number): number", "Adds one."].join("\n"))
	})

	it("retries once after the warm-up, then points the model at search_codebase", async () => {
		const source = fakeSource()
		const { codeNavigate, sleep } = tools(source)
		const result = await codeNavigate.execute({ action: "definition", path: A, symbol: "foo" }, context())
		expect(sleep).toHaveBeenCalledTimes(1)
		expect(source.calls.filter((call) => call === "definitions")).toHaveLength(2)
		expect(result).toContain("No definition found for `foo` (looked up at src/a.ts:1:10).")
		expect(result).toContain("No language server answered for .ts files")
		expect(result).toContain("search_codebase")
	})

	it("stops waiting for a file extension that never answers", async () => {
		const source = fakeSource()
		const { codeNavigate, sleep } = tools(source)
		await codeNavigate.execute({ action: "definition", path: A, symbol: "foo" }, context())
		await codeNavigate.execute({ action: "references", path: A, symbol: "foo" }, context())
		await codeNavigate.execute({ action: "definition", path: B, symbol: "foo" }, context())
		expect(sleep).toHaveBeenCalledTimes(2)
	})

	it("rejects an unknown action, a missing file and an absent symbol", async () => {
		const { codeNavigate } = tools(fakeSource())
		await expect(codeNavigate.execute({ action: "callgraph", path: A, symbol: "foo" }, context())).rejects.toThrow(
			"action must be one of",
		)
		await expect(
			codeNavigate.execute({ action: "definition", path: "/repo/missing.ts", symbol: "foo" }, context()),
		).rejects.toThrow("Cannot open missing.ts")
		await expect(codeNavigate.execute({ action: "definition", path: A, symbol: "nope" }, context())).rejects.toThrow(
			"does not appear as an identifier",
		)
	})

	it("asks for a path for every action but diagnostics, and a symbol for all but diagnostics", async () => {
		const { codeNavigate } = tools(fakeSource())
		expect(await codeNavigate.execute({ action: "diagnostics" }, context())).toContain("No errors reported in the workspace.")
		await expect(codeNavigate.execute({ action: "callers", symbol: "foo" }, context())).rejects.toThrow(
			"needs `path` (the file in which the symbol appears) for `callers`",
		)
		await expect(codeNavigate.execute({ action: "callers", path: A }, context())).rejects.toThrow(
			"needs `symbol` (an identifier that appears in the file) for `callers`",
		)
		await expect(codeNavigate.execute({ action: "diagnostics", path: "/repo/missing.ts" }, context())).rejects.toThrow(
			"Cannot open missing.ts",
		)
	})
})

describe("code_navigate callers and callees", () => {
	const useFoo: CodeCall = { name: "useFoo", kind: "function", path: A, line: 3, column: 17 }
	const foo: CodeCall = { name: "foo", kind: "function", path: B, line: 2, column: 17 }

	it("shows callers at their call site, with that line as the preview", async () => {
		const source = fakeSource({
			callHierarchy: async (p, line, column, direction) => {
				expect([p, line, column, direction]).toEqual([B, 2, 17, "incoming"])
				return { item: foo, calls: [{ ...useFoo, callSite: { path: A, line: 4, column: 9 } }] }
			},
		})
		const { codeNavigate } = tools(source)
		const result = await codeNavigate.execute({ action: "callers", path: B, symbol: "foo" }, context())
		expect(result).toBe(
			[
				"1 caller of `foo` (looked up at src/b.ts:2:17), each at its call site:",
				"function useFoo  src/a.ts:4:9  return foo(1) + foo(2)",
			].join("\n"),
		)
	})

	it("shows callees at their declaration, with the signature as the preview", async () => {
		const source = fakeSource({
			callHierarchy: async (p, line, column, direction) => {
				expect([p, line, column, direction]).toEqual([A, 3, 17, "outgoing"])
				return { item: useFoo, calls: [{ ...foo, callSite: { path: A, line: 4, column: 9 } }] }
			},
		})
		const { codeNavigate } = tools(source)
		const result = await codeNavigate.execute({ action: "callees", path: A, symbol: "useFoo" }, context())
		expect(result).toBe(
			[
				"1 callee of `useFoo` (looked up at src/a.ts:3:17), each at its declaration:",
				"function foo  src/b.ts:2:17  export function foo(x: number): number {",
			].join("\n"),
		)
	})

	it("caps the list at 25 entries", async () => {
		const calls: CodeCall[] = []
		for (let index = 1; index <= 30; index++) {
			calls.push({ name: `caller${index}`, kind: "method", path: path.join(CWD, "src", "c.ts"), line: index, column: 3 })
		}
		const { codeNavigate } = tools(fakeSource({ callHierarchy: async () => ({ item: foo, calls }) }))
		const lines = String(await codeNavigate.execute({ action: "callers", path: B, symbol: "foo" }, context())).split("\n")
		expect(lines[0]).toBe("30 callers of `foo` (looked up at src/b.ts:2:17), each at its call site:")
		expect(lines[1]).toBe("method caller1  src/c.ts:1:3")
		expect(lines).toHaveLength(27)
		expect(lines.at(-1)).toBe("+5 more")
	})

	it("explains a missing hierarchy and an empty one", async () => {
		const { codeNavigate, sleep } = tools(fakeSource())
		const missing = await codeNavigate.execute({ action: "callers", path: B, symbol: "foo" }, context())
		expect(sleep).toHaveBeenCalledTimes(1)
		expect(missing).toContain("No call hierarchy for `foo` (looked up at src/b.ts:2:17)")
		expect(missing).toContain("`references`")
		const empty = tools(fakeSource({ callHierarchy: async () => ({ item: foo, calls: [] }) })).codeNavigate
		expect(await empty.execute({ action: "callers", path: B, symbol: "foo" }, context())).toBe(
			"No callers of `foo` found (looked up at src/b.ts:2:17).",
		)
		expect(await empty.execute({ action: "callees", path: B, symbol: "foo" }, context())).toContain(
			"`foo` calls no function the language server knows of",
		)
	})
})

describe("code_navigate diagnostics", () => {
	it("lists errors before warnings, tagged with their source and code, without a symbol", async () => {
		const diagnostics: CodeDiagnostic[] = [
			{ severity: "warning", message: "'x' is declared but never used.", line: 1, column: 1, source: "eslint" },
			{
				severity: "error",
				message: "Argument of type 'string' is not assignable\n  to parameter of type 'number'.",
				line: 4,
				column: 13,
				source: "ts",
				code: "2345",
			},
		]
		const source = fakeSource({ diagnostics: async () => diagnostics })
		const { codeNavigate, sleep } = tools(source)
		const result = await codeNavigate.execute({ action: "diagnostics", path: "src/a.ts" }, context())
		expect(result).toBe(
			[
				"1 error and 1 warning in src/a.ts:",
				"4:13  error  Argument of type 'string' is not assignable to parameter of type 'number'. (ts 2345)",
				"1:1  warning  'x' is declared but never used. (eslint)",
			].join("\n"),
		)
		expect(sleep).not.toHaveBeenCalled()
	})

	it("caps the list at 20 lines", async () => {
		const diagnostics: CodeDiagnostic[] = []
		for (let line = 1; line <= 23; line++) {
			diagnostics.push({ severity: "error", message: `problem ${line}`, line, column: 1 })
		}
		const { codeNavigate } = tools(fakeSource({ diagnostics: async () => diagnostics }))
		const lines = String(await codeNavigate.execute({ action: "diagnostics", path: A }, context())).split("\n")
		expect(lines[0]).toBe("23 errors and 0 warnings in src/a.ts:")
		expect(lines).toHaveLength(22)
		expect(lines.at(-1)).toBe("+3 more")
	})

	it("checks an empty list once more after the warm-up", async () => {
		const source = fakeSource()
		const { codeNavigate, sleep } = tools(source)
		const result = await codeNavigate.execute({ action: "diagnostics", path: A }, context())
		expect(sleep).toHaveBeenCalledTimes(1)
		expect(source.calls.filter((call) => call === "diagnostics")).toHaveLength(2)
		expect(result).toContain("No errors or warnings reported for src/a.ts.")
	})
})

describe("rename_preview", () => {
	it("summarizes the edits per file with the changed lines, applying nothing", async () => {
		const source = fakeSource({
			renameEdits: async (p, line, column, newName) => {
				expect([p, line, column, newName]).toEqual([A, 1, 10, "bar"])
				return {
					files: [
						{ path: A, edits: [edit(4, 18, 3, "bar"), edit(1, 10, 3, "bar"), edit(4, 9, 3, "bar")] },
						{ path: B, edits: [edit(2, 17, 3, "bar")] },
					],
				}
			},
		})
		const { renamePreview } = tools(source)
		expect(renamePreview.name).toBe("rename_preview")
		const result = await renamePreview.execute({ path: "src/a.ts", symbol: "foo", new_name: "bar" }, context())
		expect(result).toBe(
			[
				"Renaming `foo` to `bar` (at src/a.ts:1:10) would make 4 edits in 2 files. Nothing was applied.",
				"src/a.ts: 3 edits",
				"  - line 1: import { foo } from './b' → import { bar } from './b'",
				"  - line 4: return foo(1) + foo(2) → return bar(1) + bar(2)",
				"src/b.ts: 1 edit",
				"  - line 2: export function foo(x: number): number { → export function bar(x: number): number {",
			].join("\n"),
		)
	})

	it("shows at most 3 changed lines per file", async () => {
		const edits = [1, 2, 3, 4, 5].map((line) => edit(line, 1, 0, "// "))
		const { renamePreview } = tools(fakeSource({ renameEdits: async () => ({ files: [{ path: A, edits }] }) }))
		const lines = String(await renamePreview.execute({ path: A, symbol: "useFoo", new_name: "x" }, context())).split("\n")
		expect(lines[0]).toContain("would make 5 edits in 1 file.")
		expect(lines[1]).toBe("src/a.ts: 5 edits")
		expect(lines.filter((line) => line.startsWith("  - line "))).toHaveLength(3)
		expect(lines[2]).toBe("  - line 1: import { foo } from './b' → // import { foo } from './b'")
		expect(lines.at(-1)).toBe("  +2 more lines")
	})

	it("returns the server's refusal", async () => {
		const source = fakeSource({
			renameEdits: async () => {
				source.calls.push("renameEdits")
				return { refusal: "You cannot rename this element.", files: [] }
			},
		})
		const { renamePreview } = tools(source)
		const result = await renamePreview.execute({ path: A, symbol: "foo", new_name: "bar" }, context())
		expect(result).toBe("Cannot rename `foo` at src/a.ts:1:10: You cannot rename this element.")
		expect(source.calls.filter((call) => call === "renameEdits")).toHaveLength(2)
	})

	it("rejects a missing argument and an unchanged name", async () => {
		const { renamePreview } = tools(fakeSource())
		await expect(renamePreview.execute({ path: A, symbol: "foo" }, context())).rejects.toThrow("rename_preview needs `path`")
		await expect(renamePreview.execute({ path: A, symbol: "foo", new_name: " foo " }, context())).rejects.toThrow(
			"is the current name",
		)
		await expect(renamePreview.execute({ path: A, symbol: "nope", new_name: "bar" }, context())).rejects.toThrow(
			"does not appear as an identifier",
		)
	})
})

describe("find_symbol", () => {
	const outline: CodeSymbol[] = [
		{ name: "Foo", kind: "class", path: B, line: 1, column: 14, depth: 0 },
		{ name: "bar", kind: "method", path: B, line: 3, column: 2, container: "Foo", depth: 1 },
		{ name: "qux", kind: "function", path: B, line: 9, column: 17, depth: 0 },
	]

	it("lists a file's outline, indented, and filters it by query", async () => {
		const source = fakeSource({ documentSymbols: async () => outline })
		const { findSymbol } = tools(source)
		expect(findSymbol.name).toBe("find_symbol")
		const all = await findSymbol.execute({ path: "src/b.ts" }, context())
		expect(all).toBe(
			["Outline of src/b.ts (3 symbols; kind name  line):", "class Foo  1", "  method bar  3", "function qux  9"].join(
				"\n",
			),
		)
		const filtered = await findSymbol.execute({ path: B, query: "BA" }, context())
		expect(filtered).toBe(['1 symbols matching "BA" in src/b.ts:', "  method bar  3"].join("\n"))
	})

	it("searches the workspace and shows file positions", async () => {
		const source = fakeSource({
			workspaceSymbols: async (query) => {
				expect(query).toBe("foo")
				return [
					{ name: "foo", kind: "function", path: B, line: 2, column: 17 },
					{ name: "useFoo", kind: "function", path: A, line: 3, column: 17, container: "ns" },
				]
			},
		})
		const { findSymbol } = tools(source)
		const result = await findSymbol.execute({ query: "foo" }, context())
		expect(result).toBe(
			['2 symbols matching "foo":', "function foo  src/b.ts:2:17", "function useFoo  src/a.ts:3:17  (in ns)"].join("\n"),
		)
	})

	it("explains an empty workspace answer and rejects an empty call", async () => {
		const { findSymbol } = tools(fakeSource())
		expect(await findSymbol.execute({ query: "zzz" }, context())).toContain("No workspace symbol matches")
		await expect(findSymbol.execute({}, context())).rejects.toThrow("needs a `query`")
	})
})

describe("code_navigate diagnostics without a path", () => {
	const file = (index: number) => path.join(CWD, "src", `f${index}.ts`)
	const errors = (count: number): CodeDiagnostic[] =>
		Array.from({ length: count }, (_, index) => ({
			severity: "error" as const,
			message: `problem ${index + 1}`,
			line: index + 1,
			column: 1,
		}))

	it("groups the workspace's errors by file, most first, capped at 10 files of 5 errors", async () => {
		const files: CodeFileDiagnostics[] = [
			{ path: file(0), diagnostics: [...errors(7), { severity: "warning", message: "unused", line: 9, column: 1 }] },
		]
		for (let index = 1; index <= 11; index++) {
			files.push({ path: file(index), diagnostics: errors(1) })
		}
		files.push({ path: file(99), diagnostics: [{ severity: "warning", message: "unused", line: 1, column: 1 }] })
		const source = fakeSource({ workspaceErrors: async () => files })
		const { codeNavigate, sleep } = tools(source)
		const lines = String(await codeNavigate.execute({ action: "diagnostics" }, context())).split("\n")
		expect(lines.slice(0, 10)).toEqual([
			"18 errors in 12 files across the workspace (warnings left out):",
			"src/f0.ts (7 errors)",
			"  1:1  error  problem 1",
			"  2:1  error  problem 2",
			"  3:1  error  problem 3",
			"  4:1  error  problem 4",
			"  5:1  error  problem 5",
			"  +2 more",
			"src/f1.ts (1 error)",
			"  1:1  error  problem 1",
		])
		// Ties in path order: f1, f10, f11, f2, …; f8 and f9 do not fit.
		expect(lines.filter((line) => line.startsWith("src/"))).toEqual(
			[0, 1, 10, 11, 2, 3, 4, 5, 6, 7].map((index) => `src/f${index}.ts (${index === 0 ? "7 errors" : "1 error"})`),
		)
		expect(lines.at(-1)).toBe("+2 more files with 2 errors")
		expect(sleep).not.toHaveBeenCalled()
		expect(source.calls).not.toContain("readDocument")
	})

	it("says where errors come from when there are none", async () => {
		const { codeNavigate } = tools(
			fakeSource({
				workspaceErrors: async () => [
					{ path: A, diagnostics: [{ severity: "warning", message: "x", line: 1, column: 1 }] },
				],
			}),
		)
		const result = await codeNavigate.execute({ action: "diagnostics", path: "  " }, context())
		expect(result).toContain("No errors reported in the workspace.")
		expect(result).toContain("Pass `path` to check one file.")
	})
})

describe("rename_symbol", () => {
	const renameEdits = async () => ({
		files: [
			{ path: A, edits: [edit(4, 18, 3, "bar"), edit(1, 10, 3, "bar"), edit(4, 9, 3, "bar")] },
			{ path: B, edits: [edit(2, 17, 3, "bar")] },
		],
	})
	const applied = async (): Promise<CodeRenameApplication> => ({
		applied: true,
		files: (await renameEdits()).files,
		unsaved: [],
		hadUnsavedChanges: [],
	})

	/** A new-problems check that records the order of its calls. */
	function fakeCheck(events: string[], report = "") {
		const check: EditProblemCheck = {
			written: () => events.push("written"),
			report: async () => {
				events.push("report")
				return report
			},
			dispose: () => events.push("dispose"),
		}
		return check
	}

	it("applies the server's rename, lists it like the preview, and appends the new problems", async () => {
		const events: string[] = []
		const source = fakeSource({
			renameEdits,
			applyRename: async (p, line, column, newName) => {
				events.push("apply")
				expect([p, line, column, newName]).toEqual([A, 1, 10, "bar"])
				return applied()
			},
		})
		const beginEditCheck = vi.fn((files: EditedFile[], cwd: string) => {
			events.push("begin")
			expect(cwd).toBe(CWD)
			expect(files).toEqual([
				{ absolutePath: A, displayPath: "src/a.ts" },
				{ absolutePath: B, displayPath: "src/b.ts" },
			])
			return fakeCheck(events, "\n\nNew problems reported in other files after this edit:\nsrc/c.ts\n- line 3: x")
		})
		const { renameSymbol } = tools(source, undefined, { beginEditCheck })
		expect(renameSymbol.name).toBe("rename_symbol")
		expect(renameSymbol.executionMode).toBe("sequential")
		const result = await renameSymbol.execute({ path: "src/a.ts", symbol: "foo", new_name: "bar" }, context())
		expect(result).toBe(
			[
				"Renamed `foo` to `bar` (at src/a.ts:1:10): 4 edits in 2 files, saved.",
				"src/a.ts: 3 edits",
				"  - line 1: import { foo } from './b' → import { bar } from './b'",
				"  - line 4: return foo(1) + foo(2) → return bar(1) + bar(2)",
				"src/b.ts: 1 edit",
				"  - line 2: export function foo(x: number): number { → export function bar(x: number): number {",
				"",
				"New problems reported in other files after this edit:",
				"src/c.ts",
				"- line 3: x",
			].join("\n"),
		)
		expect(events).toEqual(["begin", "apply", "written", "report", "dispose"])
	})

	it("names files it could not save and unsaved changes it saved along", async () => {
		const source = fakeSource({
			renameEdits,
			applyRename: async () => ({ ...(await applied()), unsaved: [B], hadUnsavedChanges: [A] }),
		})
		const lines = String(
			await tools(source).renameSymbol.execute({ path: A, symbol: "foo", new_name: "bar" }, context()),
		).split("\n")
		expect(lines.slice(-2)).toEqual([
			"Could not save src/b.ts: the rename is in the editor only there.",
			"src/a.ts had unsaved changes in the editor, which were saved with the rename.",
		])
	})

	it("changes nothing when the server refuses, and fails the call", async () => {
		const source = fakeSource({ renameEdits: async () => ({ refusal: "You cannot rename this element.", files: [] }) })
		const beginEditCheck = vi.fn()
		const { renameSymbol } = tools(source, undefined, { beginEditCheck })
		await expect(renameSymbol.execute({ path: A, symbol: "foo", new_name: "bar" }, context())).rejects.toThrow(
			"Cannot rename `foo` at src/a.ts:1:10: You cannot rename this element. Nothing was changed.",
		)
		expect(source.calls).not.toContain("applyRename")
		expect(beginEditCheck).not.toHaveBeenCalled()
	})

	it("fails without reporting when the editor does not apply the edit", async () => {
		const events: string[] = []
		const source = fakeSource({ renameEdits, applyRename: async () => ({ ...(await applied()), applied: false }) })
		const { renameSymbol } = tools(source, undefined, { beginEditCheck: () => fakeCheck(events) })
		await expect(renameSymbol.execute({ path: A, symbol: "foo", new_name: "bar" }, context())).rejects.toThrow(
			"The editor did not apply the rename of `foo`",
		)
		expect(events).toEqual(["dispose"])
	})

	it("checks its arguments like rename_preview", async () => {
		const { renameSymbol } = tools(fakeSource())
		await expect(renameSymbol.execute({ path: A, symbol: "foo" }, context())).rejects.toThrow("rename_symbol needs `path`")
		await expect(renameSymbol.execute({ path: A, symbol: "foo", new_name: "foo" }, context())).rejects.toThrow(
			"is the current name",
		)
	})

	it("is left out when edits are not allowed (plan and ask mode)", () => {
		const names = createCodeIntelTools({ cwd: CWD, source: fakeSource(), allowEdits: false }).map((tool) => tool.name)
		expect(names).toEqual(["find_symbol", "code_navigate", "rename_preview"])
	})
})

describe("describeRenameForApproval", () => {
	const options = (source: CodeIntelSource, timeoutMs?: number) => ({
		cwd: CWD,
		source,
		warmupMs: 1,
		sleep: async () => {},
		timeoutMs,
	})

	it("summarizes the rename the approval would apply", async () => {
		const source = fakeSource({ renameEdits: async () => ({ files: [{ path: B, edits: [edit(2, 17, 3, "bar")] }] }) })
		expect(await describeRenameForApproval(options(source), { path: B, symbol: "foo", new_name: "bar" })).toBe(
			[
				"Renaming `foo` to `bar` (at src/b.ts:2:17) will make 1 edit in 1 file and save them.",
				"src/b.ts: 1 edit",
				"  - line 2: export function foo(x: number): number { → export function bar(x: number): number {",
			].join("\n"),
		)
		expect(source.calls).not.toContain("applyRename")
	})

	it("shows a refusal, and nothing for unusable arguments or a server that does not answer in time", async () => {
		const refusing = fakeSource({ renameEdits: async () => ({ refusal: "No.", files: [] }) })
		expect(await describeRenameForApproval(options(refusing), { path: A, symbol: "foo", new_name: "bar" })).toBe(
			"Cannot rename `foo` at src/a.ts:1:10: No.",
		)
		expect(await describeRenameForApproval(options(fakeSource()), { path: A })).toBeUndefined()
		const silent = fakeSource({ renameEdits: () => new Promise(() => {}) })
		expect(await describeRenameForApproval(options(silent, 5), { path: A, symbol: "foo", new_name: "bar" })).toBeUndefined()
	})
})
