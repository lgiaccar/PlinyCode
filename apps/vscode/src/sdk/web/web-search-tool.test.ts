import type { AgentTool, AgentToolContext } from "@plinycode/shared"
import { describe, expect, it } from "vitest"
import type { SearchBackend, SearchHit } from "./web-search-backends"
import { createWebSearchTools, type WebSearchSetup } from "./web-search-tool"

const context = { agentId: "a", conversationId: "c", iteration: 1 } as unknown as AgentToolContext

function hit(index: number, extra: Partial<SearchHit> = {}): SearchHit {
	return {
		title: `Result ${index}`,
		url: `https://www.example${index}.com/page`,
		snippet: `Snippet ${index}`,
		...extra,
	}
}

function fakeBackend(hits: SearchHit[] | Error) {
	const calls: Array<{ query: string; count: number; site?: string }> = []
	const backend: SearchBackend = {
		id: "duckduckgo-html",
		async search(query, options) {
			calls.push({ query, count: options.count, site: options.site })
			if (hits instanceof Error) {
				throw hits
			}
			return hits.slice(0, options.count)
		},
	}
	return { backend, calls }
}

function toolFor(setup: WebSearchSetup): AgentTool {
	const tools = createWebSearchTools({ setup, providerId: "pliny", modelId: "pliny/free-auto" })
	expect(tools).toHaveLength(1)
	return tools[0]
}

describe("createWebSearchTools", () => {
	it("adds web_search for a provider without native search", () => {
		const { backend } = fakeBackend([])
		const [tool] = createWebSearchTools({ setup: { backend, maxResults: 8 }, providerId: "pliny", modelId: "x" })
		expect(tool.name).toBe("web_search")
		expect(tool.executionMode).toBe("parallel")
		expect(tool.retryable).toBe(true)
		expect(tool.maxRetries).toBe(1)
		expect(tool.timeoutMs).toBe(30_000)
		expect(tool.description.split(/\s+/).length).toBeLessThanOrEqual(120)
	})

	it("adds nothing when web search is off", () => {
		expect(createWebSearchTools({ setup: undefined, providerId: "pliny" })).toEqual([])
	})

	it("adds nothing when the provider has a native web_search model tool", () => {
		const { backend } = fakeBackend([])
		expect(
			createWebSearchTools({ setup: { backend, maxResults: 8 }, providerId: "anthropic", modelId: "claude-sonnet-4-5" }),
		).toEqual([])
	})
})

describe("web_search", () => {
	it("formats each hit as title — host, url and snippet, then the read-first line", async () => {
		const { backend, calls } = fakeBackend([hit(1), hit(2, { snippet: "" })])
		const output = await toolFor({ backend, maxResults: 8 }).execute({ query: " bun lockfile ", site: "bun.sh" }, context)

		expect(output).toBe(
			[
				"1. Result 1 — example1.com",
				"   https://www.example1.com/page",
				"   Snippet 1",
				"2. Result 2 — example2.com",
				"   https://www.example2.com/page",
				"",
				"Read a page with fetch_web_content before relying on it.",
			].join("\n"),
		)
		expect(calls).toEqual([{ query: "bun lockfile", count: 8, site: "bun.sh" }])
	})

	it("cuts snippets to 200 characters", async () => {
		const { backend } = fakeBackend([hit(1, { snippet: "word ".repeat(100) })])
		const output = (await toolFor({ backend, maxResults: 8 }).execute({ query: "q" }, context)) as string
		const snippetLine = output.split("\n")[2]

		expect(snippetLine.trim().length).toBeLessThanOrEqual(200)
		expect(snippetLine.endsWith("…")).toBe(true)
	})

	it("uses the setting's count by default and caps a requested count at 10", async () => {
		const many = Array.from({ length: 15 }, (_, index) => hit(index + 1))
		const { backend, calls } = fakeBackend(many)
		const tool = toolFor({ backend, maxResults: 3 })

		const byDefault = (await tool.execute({ query: "q" }, context)) as string
		expect(byDefault.match(/^\d+\. /gm)).toHaveLength(3)

		const capped = (await tool.execute({ query: "q", count: 50 }, context)) as string
		expect(capped.match(/^\d+\. /gm)).toHaveLength(10)
		expect(calls.map((call) => call.count)).toEqual([3, 10])
	})

	it("keeps an out-of-range maxResults setting within 1-10", async () => {
		const { backend, calls } = fakeBackend([hit(1)])
		await toolFor({ backend, maxResults: 40 }).execute({ query: "q" }, context)
		await toolFor({ backend, maxResults: 0 }).execute({ query: "q" }, context)
		expect(calls.map((call) => call.count)).toEqual([10, 1])
	})

	it("says so and suggests rephrasing when nothing is found", async () => {
		const { backend } = fakeBackend([])
		const output = await toolFor({ backend, maxResults: 8 }).execute({ query: "zzqx", site: "example.com" }, context)

		expect(output).toBe(
			'No results for "zzqx" on example.com. Rephrase the query: fewer or more general words, without quotes, or without `site`.',
		)
	})

	it("passes the backend's error message through", async () => {
		const { backend } = fakeBackend(new Error("Brave Search search failed: HTTP 429 Too Many Requests: rate limited"))
		await expect(toolFor({ backend, maxResults: 8 }).execute({ query: "q" }, context)).rejects.toThrow(
			"Brave Search search failed: HTTP 429 Too Many Requests: rate limited",
		)
	})

	it("needs a query", async () => {
		const { backend, calls } = fakeBackend([hit(1)])
		await expect(toolFor({ backend, maxResults: 8 }).execute({ query: "  " }, context)).rejects.toThrow(
			"web_search needs a `query`.",
		)
		expect(calls).toHaveLength(0)
	})
})
