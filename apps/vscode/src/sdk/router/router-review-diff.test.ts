import type { AgentMessage } from "@plinycode/shared"
import { describe, expect, it } from "vitest"
import {
	assessChanges,
	buildReviewDiff,
	changesFromCheckpoint,
	changesFromToolCalls,
	countSuccessfulEdits,
	currentTurnMessages,
	isDocsPath,
	isSuccessfulEdit,
	REVIEW_DIFF_MAX_CHARS,
	type ReviewFileChange,
} from "./router-review-diff"

let nextId = 0

function user(text: string, metadata?: Record<string, unknown>): AgentMessage {
	return {
		id: `u${++nextId}`,
		role: "user",
		content: [{ type: "text", text }],
		createdAt: 0,
		...(metadata ? { metadata } : {}),
	}
}

function assistant(text: string): AgentMessage {
	return { id: `a${++nextId}`, role: "assistant", content: [{ type: "text", text }], createdAt: 0 }
}

/** An assistant tool call followed by its result, as the runtime stores them. */
function toolRound(toolName: string, input: unknown, output: unknown, isError?: boolean): AgentMessage[] {
	const toolCallId = `c${++nextId}`
	return [
		{ id: `a${nextId}`, role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, input }], createdAt: 0 },
		{
			id: `t${nextId}`,
			role: "tool",
			content: [{ type: "tool-result", toolCallId, toolName, output, ...(isError ? { isError } : {}) }],
			createdAt: 0,
		},
	]
}

const OK = { query: "edit:src/a.ts", result: "Edited", success: true }
const FAILED = { query: "edit:src/a.ts", result: "", error: "Editor operation failed: no match", success: false }

function change(path: string, lines: number, extra: Partial<ReviewFileChange> = {}): ReviewFileChange {
	const diff = Array.from({ length: lines }, (_, index) => `+const value${index} = ${index}`).join("\n")
	return { path, diff, added: lines, removed: 0, ...extra }
}

describe("changesFromCheckpoint", () => {
	it("turns a modified file into a unified hunk with line numbers and counts", () => {
		const left = "one\ntwo\nthree\nfour\nfive\n"
		const right = "one\ntwo\nTHREE\nfour\nfive\nsix\n"
		const [file] = changesFromCheckpoint([{ filePath: "/repo/src/a.ts", leftContent: left, rightContent: right }], "/repo")
		expect(file).toMatchObject({ path: "src/a.ts", added: 2, removed: 1, status: "modified" })
		expect(file?.diff).toContain("@@ -1,5 +1,6 @@")
		expect(file?.diff).toContain("-three")
		expect(file?.diff).toContain("+THREE")
		expect(file?.diff).toContain("+six")
	})

	it("marks new and deleted files, and does not spend the budget on deleted content", () => {
		const changes = changesFromCheckpoint(
			[
				{ filePath: "/repo/new.ts", leftContent: "", rightContent: "export const a = 1\n" },
				{ filePath: "/repo/old.ts", leftContent: "a\nb\nc\n", rightContent: "" },
			],
			"/repo",
		)
		expect(changes[0]).toMatchObject({ path: "new.ts", status: "added", added: 1, removed: 0 })
		expect(changes[1]).toMatchObject({ path: "old.ts", status: "deleted", added: 0, removed: 3, diff: "" })
	})

	it("drops a file whose only change is its line endings", () => {
		expect(
			changesFromCheckpoint([{ filePath: "/repo/a.ts", leftContent: "a\r\nb\r\n", rightContent: "a\nb\n" }], "/repo"),
		).toEqual([])
	})

	it("names a binary file without diffing it", () => {
		const [file] = changesFromCheckpoint(
			[{ filePath: "/repo/logo.png", leftContent: "\u0000PNG", rightContent: "\u0000PNG2" }],
			"/repo",
		)
		expect(file).toMatchObject({ path: "logo.png", opaque: true, diff: "" })
	})
})

describe("edit detection", () => {
	it("counts only successful editor and apply_patch calls", () => {
		expect(isSuccessfulEdit("editor", { output: OK })).toBe(true)
		expect(isSuccessfulEdit("apply_patch", { output: { query: "apply_patch", result: "ok", success: true } })).toBe(true)
		expect(isSuccessfulEdit("editor", { output: FAILED })).toBe(false)
		expect(isSuccessfulEdit("editor", { output: OK, isError: true })).toBe(false)
		expect(isSuccessfulEdit("run_commands", { output: [{ query: "sed -i", result: "", success: true }] })).toBe(false)
		expect(isSuccessfulEdit("read_files", { output: "contents" })).toBe(false)

		const messages = [
			...toolRound("read_files", {}, "contents"),
			...toolRound("editor", { path: "src/a.ts", new_text: "x" }, OK),
			...toolRound("editor", { path: "src/a.ts", old_text: "nope", new_text: "y" }, FAILED),
		]
		expect(countSuccessfulEdits(messages)).toBe(1)
	})
})

describe("currentTurnMessages", () => {
	it("starts after the user's latest own message, ignoring injected reminders", () => {
		const earlier = [user("first request"), ...toolRound("editor", { path: "old.ts", new_text: "x" }, OK), assistant("Done.")]
		const turn = [
			...toolRound("editor", { path: "src/a.ts", new_text: "x" }, OK),
			user("[SYSTEM] Your last message said what you would do next", { displayRole: "system", userRunSpan: 0 }),
			assistant("Done."),
		]
		const messages = [...earlier, user("second request"), ...turn]
		expect(currentTurnMessages(messages, turn)).toEqual(turn)
		expect(countSuccessfulEdits(currentTurnMessages(messages, turn))).toBe(1)
	})

	it("reaches back past a recovered run to the user's message", () => {
		const beforeFailure = toolRound("editor", { path: "src/a.ts", new_text: "x" }, OK)
		const continuation = [
			user("Your previous reply was cut off.", { displayRole: "system", userRunSpan: 0 }),
			assistant("Done."),
		]
		const messages = [user("request"), ...beforeFailure, ...continuation]
		// The continuation's own run holds no edit; the turn does.
		expect(countSuccessfulEdits(continuation)).toBe(0)
		expect(countSuccessfulEdits(currentTurnMessages(messages, continuation))).toBe(1)
	})

	it("keeps the whole run when the user sent a message in the middle of it", () => {
		const run = [...toolRound("editor", { path: "src/a.ts", new_text: "x" }, OK), user("also rename it"), assistant("Done.")]
		const messages = [user("request"), ...run]
		expect(currentTurnMessages(messages, run)).toEqual(run)
	})
})

describe("changesFromToolCalls", () => {
	it("rebuilds replaced, inserted and created text per file, in call order", () => {
		const messages = [
			...toolRound(
				"editor",
				{ path: "/repo/src/a.ts", old_text: "const a = 1\nconst b = 2", new_text: "const a = 1\nconst b = 3" },
				OK,
			),
			...toolRound("editor", { path: "/repo/src/a.ts", new_text: "import x from 'x'", insert_line: 1 }, OK),
			...toolRound("editor", { path: "/repo/src/new.ts", new_text: "export const n = 1\nexport const m = 2\n" }, OK),
			...toolRound("editor", { path: "/repo/src/b.ts", old_text: "x", new_text: "y" }, FAILED),
		]
		const changes = changesFromToolCalls(messages, "/repo")
		expect(changes.map((entry) => entry.path)).toEqual(["src/a.ts", "src/new.ts"])
		expect(changes[0]).toMatchObject({ added: 2, removed: 1 })
		expect(changes[0]?.diff).toBe(
			[
				"@@ text replaced @@",
				" const a = 1",
				"-const b = 2",
				"+const b = 3",
				"@@ inserted at line 1 @@",
				"+import x from 'x'",
			].join("\n"),
		)
		expect(changes[1]).toMatchObject({ added: 2, removed: 0 })
		expect(changes[1]?.diff).toContain("@@ file written @@\n+export const n = 1")
	})

	it("splits an apply_patch payload into its files", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/a.ts",
			"@@",
			" const a = 1",
			"-const b = 2",
			"+const b = 3",
			"*** Add File: src/c.ts",
			"+export const c = 1",
			"*** End Patch",
		].join("\n")
		const changes = changesFromToolCalls(
			toolRound("apply_patch", { input: patch }, { query: "apply_patch", result: "ok", success: true }),
		)
		expect(changes).toEqual([
			{ path: "src/a.ts", diff: "@@\n const a = 1\n-const b = 2\n+const b = 3", added: 1, removed: 1, status: "modified" },
			{ path: "src/c.ts", diff: "+export const c = 1", added: 1, removed: 0, status: "added" },
		])
	})
})

describe("assessChanges", () => {
	it("skips a run that changed nothing", () => {
		expect(assessChanges([]).skip).toBe("no-changes")
	})

	it("skips a change to documentation, lockfiles and binaries only", () => {
		expect(isDocsPath("docs/guide.md")).toBe(true)
		expect(isDocsPath("README")).toBe(true)
		expect(isDocsPath("notes.TXT")).toBe(true)
		expect(isDocsPath("src/readme.ts")).toBe(false)
		expect(isDocsPath("Makefile")).toBe(false)
		const assessed = assessChanges([
			change("docs/guide.md", 40),
			change("bun.lock", 200),
			change("logo.png", 0, { opaque: true }),
		])
		expect(assessed.skip).toBe("docs-only")
		expect(assessed.namedOnly).toEqual(["docs/guide.md", "bun.lock", "logo.png"])
	})

	it("skips a code change under three lines, counting code only", () => {
		expect(assessChanges([change("src/a.ts", 2)]).skip).toBe("small-change")
		expect(assessChanges([change("src/a.ts", 2), change("README.md", 50)]).skip).toBe("small-change")
		expect(assessChanges([change("src/a.ts", 1, { removed: 2 })]).skip).toBeUndefined()
	})

	it("reviews the code of a mixed change and only names the rest", () => {
		const assessed = assessChanges([change("src/a.ts", 10), change("docs/guide.md", 40)])
		expect(assessed.skip).toBeUndefined()
		expect(assessed.reviewable.map((entry) => entry.path)).toEqual(["src/a.ts"])
		expect(assessed.namedOnly).toEqual(["docs/guide.md"])
		expect(assessed).toMatchObject({ added: 10, removed: 0 })
	})
})

describe("buildReviewDiff", () => {
	it("shows a change that fits in full", () => {
		const built = buildReviewDiff(
			[change("src/a.ts", 3, { status: "added" }), change("src/b.ts", 2, { removed: 1 })],
			["README.md"],
		)
		expect(built.truncated).toEqual([])
		expect(built.omitted).toEqual([])
		expect(built.text).toContain("=== src/a.ts (new file, +3 -0) ===\n+const value0 = 0")
		expect(built.text).toContain("=== src/b.ts (+2 -1) ===")
		expect(built.text).toContain(
			"[Also changed, not shown (documentation, lockfiles, binary or very large files): README.md]",
		)
	})

	it("cuts a long file at a line boundary, says so, and stays near the cap", () => {
		const built = buildReviewDiff([change("src/small.ts", 5), change("src/huge.ts", 5000)])
		expect(built.truncated).toEqual(["src/huge.ts"])
		// The short file keeps every line; only the long one pays.
		expect(built.text).toContain("+const value4 = 4")
		expect(built.text).toMatch(/\[… \d+ more lines of this file's diff are not shown\]/)
		expect(built.text.length).toBeLessThanOrEqual(REVIEW_DIFF_MAX_CHARS + 200)
		expect(built.text.length).toBeGreaterThan(REVIEW_DIFF_MAX_CHARS - 2000)
		const lastShown = built.text
			.split("\n")
			.filter((line) => line.startsWith("+const value"))
			.at(-1)
		expect(lastShown).toMatch(/^\+const value\d+ = \d+$/)
	})

	it("shares the cap between several long files", () => {
		const built = buildReviewDiff([change("src/a.ts", 3000), change("src/b.ts", 3000), change("src/c.ts", 3000)], [], 9000)
		expect(built.truncated).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"])
		for (const name of ["a", "b", "c"]) {
			expect(built.text).toContain(`=== src/${name}.ts`)
		}
		expect(built.text.length).toBeLessThanOrEqual(9000 + 300)
	})

	it("names the files that do not fit at all", () => {
		const files = Array.from({ length: 8 }, (_, index) => change(`src/file${index}.ts`, 200))
		const built = buildReviewDiff(files, [], 3000)
		expect(built.omitted).toEqual(["src/file5.ts", "src/file6.ts", "src/file7.ts"])
		expect(built.text).toContain("[3 more changed files are not shown: src/file5.ts, src/file6.ts, src/file7.ts]")
		expect(built.text).not.toContain("=== src/file5.ts")
	})
})
