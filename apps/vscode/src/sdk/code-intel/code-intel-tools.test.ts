import type { AgentToolContext } from "@plinycode/shared"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import { formatLocations, locateSymbol, reduceHoverMarkdown } from "./code-intel-format"
import type { CodeCall, CodeDiagnostic, CodeIntelSource, CodeLocation, CodeSymbol, CodeTextEdit } from "./code-intel-source"
import { createCodeIntelTools } from "./code-intel-tools"

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
		renameEdits: async () => record("renameEdits", undefined),
		...overrides,
	}
}

function tools(source: CodeIntelSource, sleep = vi.fn(async () => {})) {
	const [findSymbol, codeNavigate, renamePreview] = createCodeIntelTools({ cwd: CWD, source, warmupMs: 1, sleep })
	return { findSymbol, codeNavigate, renamePreview, sleep }
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

	it("asks for a path for every action and a symbol for all but diagnostics", async () => {
		const { codeNavigate } = tools(fakeSource())
		await expect(codeNavigate.execute({ action: "diagnostics" }, context())).rejects.toThrow("needs `path`")
		await expect(codeNavigate.execute({ action: "callers", symbol: "foo" }, context())).rejects.toThrow("needs `path`")
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
