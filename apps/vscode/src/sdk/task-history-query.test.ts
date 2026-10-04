import type { SessionHistoryRecord } from "@plinycode/core"
import { describe, expect, it } from "vitest"
import { queryTaskHistory, taskHistoryRowMatches } from "./task-history-query"

type TaskHistoryRow = Parameters<typeof taskHistoryRowMatches>[0]

function makeRecord(id: string, overrides: Partial<SessionHistoryRecord> = {}): SessionHistoryRecord {
	return {
		sessionId: id,
		source: "vscode",
		pid: 1,
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: null,
		exitCode: null,
		status: "completed",
		interactive: true,
		provider: "pliny",
		model: "model",
		cwd: "/repo",
		workspaceRoot: "/repo",
		enableTools: true,
		enableSpawn: true,
		enableTeams: false,
		isSubagent: false,
		prompt: id,
		metadata: {},
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	}
}

const ids = (records: SessionHistoryRecord[]) => records.map((record) => record.sessionId)

describe("queryTaskHistory", () => {
	it("finds favorites however old they are", () => {
		// The favorite is older than 60 newer conversations: paging before
		// filtering never reached it.
		const records = [
			...Array.from({ length: 60 }, (_, index) =>
				makeRecord(`recent-${index}`, { updatedAt: new Date(Date.UTC(2026, 5, 1, 0, index)).toISOString() }),
			),
			makeRecord("old-favorite", { updatedAt: "2025-01-01T00:00:00.000Z", metadata: { isFavorited: true } }),
			makeRecord("legacy-favorite", { updatedAt: "2024-01-01T00:00:00.000Z", metadata: { is_favorited: true } }),
		]

		expect(ids(queryTaskHistory(records, { favoritesOnly: true }))).toEqual(["old-favorite", "legacy-favorite"])
	})

	it("lists pinned conversations first, each part in the sort order", () => {
		const records = [
			makeRecord("newest", { updatedAt: "2026-03-03T00:00:00.000Z" }),
			makeRecord("pinned-old", { updatedAt: "2026-01-01T00:00:00.000Z", metadata: { isPinned: true } }),
			makeRecord("middle", { updatedAt: "2026-02-02T00:00:00.000Z" }),
			makeRecord("pinned-new", { updatedAt: "2026-02-15T00:00:00.000Z", metadata: { isPinned: true } }),
		]

		expect(ids(queryTaskHistory(records, {}))).toEqual(["pinned-new", "pinned-old", "newest", "middle"])
		expect(ids(queryTaskHistory(records, { sortBy: "oldest" }))).toEqual(["pinned-old", "pinned-new", "middle", "newest"])
	})

	it("sorts by cost and by tokens", () => {
		const records = [
			makeRecord("cheap", { metadata: { totalCost: 0.1, tokensIn: 900, tokensOut: 100 } }),
			makeRecord("expensive", { metadata: { totalCost: 2, tokensIn: 10, cacheReads: 5 } }),
		]

		expect(ids(queryTaskHistory(records, { sortBy: "mostExpensive" }))).toEqual(["expensive", "cheap"])
		expect(ids(queryTaskHistory(records, { sortBy: "mostTokens" }))).toEqual(["cheap", "expensive"])
	})

	it("matches every search term against the title or the workspace, in any case", () => {
		const records = [
			makeRecord("a", { metadata: { title: "Fix the Login redirect" }, workspaceRoot: "/work/shop" }),
			makeRecord("b", { metadata: { title: "Login page styling" }, workspaceRoot: "/work/blog" }),
			makeRecord("c", { prompt: "Refactor the cart", workspaceRoot: "/work/shop" }),
		]

		expect(ids(queryTaskHistory(records, { searchQuery: "login" })).sort()).toEqual(["a", "b"])
		expect(ids(queryTaskHistory(records, { searchQuery: "  LOGIN   redirect " }))).toEqual(["a"])
		expect(ids(queryTaskHistory(records, { searchQuery: "shop" })).sort()).toEqual(["a", "c"])
		expect(ids(queryTaskHistory(records, { searchQuery: "login shop" }))).toEqual(["a"])
		expect(queryTaskHistory(records, { searchQuery: "checkout" })).toEqual([])
	})

	it("keeps only the conversations bound to the workspace", () => {
		const records = [
			makeRecord("bound", { workspaceRoot: "/work/shop", metadata: { workspacePath: "/work/all.code-workspace" } }),
			makeRecord("folder", { workspaceRoot: "/work/shop" }),
		]

		expect(ids(queryTaskHistory(records, { workspacePath: "/work/shop" }))).toEqual(["folder"])
		expect(ids(queryTaskHistory(records, { workspacePath: "/work/all.code-workspace" }))).toEqual(["bound"])
	})

	it("drops records with no title or no timestamp", () => {
		const records = [
			makeRecord("untitled", { prompt: "" }),
			makeRecord("undated", { updatedAt: undefined, endedAt: null, startedAt: "" }),
			makeRecord("fine"),
		]

		expect(ids(queryTaskHistory(records, {}))).toEqual(["fine"])
	})

	it("combines the filters", () => {
		const records = [
			makeRecord("match", {
				updatedAt: "2026-03-10T12:00:00.000Z",
				metadata: { title: "Review the parser", isFavorited: true },
			}),
			makeRecord("not-favorite", { updatedAt: "2026-03-10T12:00:00.000Z", metadata: { title: "Review the parser" } }),
			makeRecord("too-old", {
				updatedAt: "2026-01-10T12:00:00.000Z",
				metadata: { title: "Review the parser", isFavorited: true },
			}),
		]

		expect(
			ids(
				queryTaskHistory(records, {
					favoritesOnly: true,
					searchQuery: "parser",
					fromTs: Date.parse("2026-03-01T00:00:00.000Z"),
				}),
			),
		).toEqual(["match"])
	})
})

describe("taskHistoryRowMatches date range", () => {
	const march5 = Date.parse("2026-03-05T00:00:00.000Z")
	const march10 = Date.parse("2026-03-10T00:00:00.000Z")
	const row = (startedTs: number, lastActiveTs: number): TaskHistoryRow => ({
		title: "task",
		workspacePath: "/repo",
		startedTs,
		lastActiveTs,
		isFavorited: false,
	})
	const day = (n: number) => Date.parse(`2026-03-${String(n).padStart(2, "0")}T12:00:00.000Z`)

	it("keeps a conversation that was active at any point in the period", () => {
		const query = { fromTs: march5, toTs: march10 }

		expect(taskHistoryRowMatches(row(day(6), day(7)), query)).toBe(true) // inside
		expect(taskHistoryRowMatches(row(day(1), day(6)), query)).toBe(true) // started before, active inside
		expect(taskHistoryRowMatches(row(day(9), day(20)), query)).toBe(true) // started inside, still active after
		expect(taskHistoryRowMatches(row(day(1), day(20)), query)).toBe(true) // spans the period
		expect(taskHistoryRowMatches(row(day(1), day(4)), query)).toBe(false) // over before it
		expect(taskHistoryRowMatches(row(day(11), day(12)), query)).toBe(false) // started after it
	})

	it("treats 0 as an open side", () => {
		expect(taskHistoryRowMatches(row(day(1), day(2)), { fromTs: 0, toTs: 0 })).toBe(true)
		expect(taskHistoryRowMatches(row(day(1), day(2)), { fromTs: march5 })).toBe(false)
		expect(taskHistoryRowMatches(row(day(11), day(12)), { fromTs: march5 })).toBe(true)
		expect(taskHistoryRowMatches(row(day(11), day(12)), { toTs: march10 })).toBe(false)
		expect(taskHistoryRowMatches(row(day(1), day(20)), { toTs: march10 })).toBe(true)
	})
})
