import { describe, expect, it, vi } from "vitest"
import { type ConversationIndex, ConversationSearch, type IndexHit, type SearchableSession } from "./conversation-search"
import { createConversationSearchTools } from "./conversation-search-tools"

const user = (text: string, metadata?: Record<string, unknown>) => ({ role: "user", content: [{ type: "text", text }], metadata })
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })

const SESSIONS: SearchableSession[] = [
	{ sessionId: "s1", startedAt: "2026-10-01T10:00:00Z", updatedAt: "", workspaceRoot: "/work/a", prompt: "fix the pager" },
	{ sessionId: "s2", startedAt: "2026-10-02T10:00:00Z", updatedAt: "", workspaceRoot: "/work/b", prompt: "pager again" },
]

const MESSAGES: Record<string, unknown[]> = {
	s1: [
		user("git log hangs in the terminal"),
		assistant("The pager waits for input; use git --no-pager log."),
		user("secret side question about the pager", { offTheRecord: true }),
		assistant("side answer"),
		user("thanks"),
	],
	s2: [user("the pager is back"), assistant("Set GIT_PAGER=cat.")],
}

function source() {
	return {
		listSessions: vi.fn(async () => SESSIONS),
		readMessages: vi.fn(async (id: string) => MESSAGES[id] ?? []),
	}
}

function hit(sessionId: string, workspaceRoot: string): IndexHit {
	return {
		sessionId,
		ordinal: 1,
		role: "assistant",
		startedAt: "2026-10-01T10:00:00Z",
		workspaceRoot,
		title: "t",
		snippet: "[pager]",
	}
}

function fakeIndex(hits: IndexHit[], available = true): ConversationIndex {
	return {
		start: vi.fn(),
		refreshNow: vi.fn(async () => {}),
		isAvailable: () => available,
		search: vi.fn(() => hits),
		dispose: vi.fn(async () => {}),
	}
}

describe("ConversationSearch with the full-text index", () => {
	it("starts the index on first use and filters by folder and current conversation", async () => {
		const index = fakeIndex([hit("s1", "/work/a"), hit("s2", "/work/b"), hit("current", "/work/a")])
		const createIndex = vi.fn(() => index)
		const search = new ConversationSearch({ source: source(), createIndex })

		const hits = await search.search({ query: "pager", workspaceRoot: "/work/a/", excludeSessionId: "current" })
		expect(hits.map((entry) => entry.sessionId)).toEqual(["s1"])
		// The folder goes to the index's own filter, so other workspaces cannot crowd it out.
		expect(index.search).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: "/work/a/" }))
		expect(index.start).toHaveBeenCalledTimes(1)

		await search.search({ query: "pager" })
		expect(createIndex).toHaveBeenCalledTimes(1)
		expect(index.refreshNow).toHaveBeenCalledTimes(2)
	})

	it("does not wait forever for the index to catch up", async () => {
		const index = fakeIndex([hit("s1", "/work/a")])
		index.refreshNow = () => new Promise(() => {})
		const search = new ConversationSearch({ source: source(), createIndex: () => index, readyTimeoutMs: 20 })
		expect(await search.search({ query: "pager" })).toHaveLength(1)
	})
})

describe("ConversationSearch without SQLite", () => {
	it("scans the recent transcripts, leaving side questions out", async () => {
		const search = new ConversationSearch({ source: source(), createIndex: () => fakeIndex([], false) })

		const hits = await search.search({ query: "pager --no-pager" })
		expect(hits.map((entry) => entry.sessionId)).toEqual(["s1"])
		expect(hits[0].ordinal).toBe(1)

		expect(await search.search({ query: "secret side" })).toEqual([])
		expect((await search.search({ query: "pager", workspaceRoot: "/work/b" })).map((entry) => entry.sessionId)).toEqual([
			"s2",
		])
	})
})

describe("messageToText", () => {
	it("leaves out the editor state and mode notices the extension added", async () => {
		const { messageToText } = await import("./conversation-search")
		const text = messageToText(
			user(
				"<mode_notice>The user switched from plan mode to act mode.</mode_notice>\nfix the pager\n\n<editor_state>\nActive file: src/app.ts\n</editor_state>",
			),
		)
		expect(text).toBe("fix the pager")
	})
})

describe("ConversationSearch.read", () => {
	it("returns the messages around a hit without side questions", async () => {
		const search = new ConversationSearch({ source: source(), createIndex: () => fakeIndex([]) })
		const text = await search.read("s1", 1)
		expect(text).toContain("#0 user:\ngit log hangs")
		expect(text).toContain("#1 assistant:\nThe pager waits")
		expect(text).toContain("#4 user:\nthanks")
		expect(text).not.toContain("secret side question")
		expect(text).not.toContain("side answer")
	})

	it("stays within its budget, centred on the hit", async () => {
		const long = Array.from({ length: 50 }, (_, index) => assistant(`message ${index} ${"x".repeat(200)}`))
		const search = new ConversationSearch({
			source: { listSessions: async () => [], readMessages: async () => long },
			createIndex: () => fakeIndex([]),
		})
		const text = await search.read("long", 25, 1000)
		expect(text).toContain("#25 assistant")
		expect(text).not.toContain("#0 assistant")
		expect(text.length).toBeLessThan(1300)
	})

	it("says when the conversation does not exist", async () => {
		const search = new ConversationSearch({ source: source(), createIndex: () => fakeIndex([]) })
		await expect(search.read("missing", undefined)).rejects.toThrow(/No conversation/)
	})
})

describe("search_conversations and read_conversation", () => {
	it("search this workspace by default and leave out the searching conversation", async () => {
		const searchMock = vi.fn(async () => [hit("s1", "/work/a")])
		const [searchTool, readTool] = createConversationSearchTools({
			search: { search: searchMock, read: vi.fn(async () => "transcript") },
			getCwd: () => "/work/a",
			getConversationId: (context) => context.sessionId,
		})
		const context = { agentId: "a", iteration: 1, sessionId: "current" }

		const result = await searchTool.execute({ query: "pager" }, context)
		expect(searchMock).toHaveBeenCalledWith({
			query: "pager",
			workspaceRoot: "/work/a",
			excludeSessionId: "current",
			limit: undefined,
		})
		expect(result).toContain("session_id: s1 (2026-10-01)")
		expect(result).toContain("message 1 (assistant): [pager]")

		await searchTool.execute({ query: "pager", all_workspaces: true }, context)
		expect(searchMock).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceRoot: undefined }))

		expect(await readTool.execute({ session_id: "s1", around_message: 1 }, context)).toBe("transcript")
		await expect(searchTool.execute({}, context)).rejects.toThrow(/query/)
	})

	it("suggest searching everywhere when nothing matches here", async () => {
		const [searchTool] = createConversationSearchTools({
			search: { search: async () => [], read: async () => "" },
			getCwd: () => "/work/a",
			getConversationId: () => undefined,
		})
		expect(await searchTool.execute({ query: "nothing" }, { agentId: "a", iteration: 1 })).toMatch(/all_workspaces: true/)
	})
})
