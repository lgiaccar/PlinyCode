import { describe, expect, it } from "vitest"
import { createSearchBackend } from "./web-search-backends"

/** A recorded answer for one request; the fake fetch never touches the network. */
function fakeFetch(body: string, init: { status?: number; statusText?: string } = {}) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = []
	const fetch = async (url: string, request?: RequestInit) => {
		calls.push({ url, headers: (request?.headers ?? {}) as Record<string, string> })
		return new Response(body, { status: init.status ?? 200, statusText: init.statusText })
	}
	return { fetch, calls }
}

// Trimmed from a real html.duckduckgo.com answer: one ad, two organic results
// (the first through the uddg redirect), one result with an unusable link.
const DDG_HTML = `<!DOCTYPE html><html><body><div id="links" class="results">
<div class="result results_links results_links_deep result--ad">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=example.com&amp;ad_provider=bing">Sponsored thing</a></h2>
    <a class="result__snippet" href="https://duckduckgo.com/y.js?ad_domain=example.com">Buy it now</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2Fdocs%2Fcli%2Finstall%3Fx%3D1&amp;rut=abc123">Bun install &amp; the <b>lockfile</b></a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2Fdocs%2Fcli%2Finstall">
      Use <b>bun install</b> --frozen-lockfile in CI   so the lockfile is never rewritten.
    </a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://github.com/oven-sh/bun/releases">Releases · oven-sh/bun</a></h2>
    <a class="result__snippet">Release notes for every Bun version.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="javascript:void(0)">Broken</a></h2>
  </div>
</div>
</div></body></html>`

const SEARXNG_JSON = JSON.stringify({
	query: "vitest mock",
	results: [
		{ title: "Mocking | Vitest", url: "https://vitest.dev/guide/mocking", content: "vi.mock replaces a module." },
		{ title: "Duplicate", url: "https://vitest.dev/guide/mocking", content: "same url" },
		{ title: "Not a web page", url: "magnet:?xt=urn", content: "skipped" },
		{ title: "vi.fn", url: "https://vitest.dev/api/vi", content: "Creates a spy." },
	],
})

const BRAVE_JSON = JSON.stringify({
	type: "search",
	web: {
		results: [
			{
				title: "Node.js <strong>22</strong> release notes",
				url: "https://nodejs.org/en/blog/release/v22.0.0",
				description: "What&#x27;s new in <strong>Node.js 22</strong> &amp; more.",
			},
			{ title: "Second", url: "https://example.org/b", description: "B" },
		],
	},
})

const GOOGLE_JSON = JSON.stringify({
	kind: "customsearch#search",
	items: [
		{ title: "TS2307: Cannot find module", link: "https://stackoverflow.com/q/1", snippet: "Check your paths mapping." },
		{ title: "tsconfig paths", link: "https://www.typescriptlang.org/tsconfig#paths", snippet: "Re-map imports." },
	],
})

describe("duckduckgo-html", () => {
	it("parses results, unwraps the uddg redirect and skips ads and unusable links", async () => {
		const { fetch, calls } = fakeFetch(DDG_HTML)
		const backend = createSearchBackend({ provider: "duckduckgo-html", fetch })
		const hits = await backend.search("bun frozen lockfile", { count: 8 })

		expect(hits).toEqual([
			{
				title: "Bun install & the lockfile",
				url: "https://bun.sh/docs/cli/install?x=1",
				snippet: "Use bun install --frozen-lockfile in CI so the lockfile is never rewritten.",
			},
			{
				title: "Releases · oven-sh/bun",
				url: "https://github.com/oven-sh/bun/releases",
				snippet: "Release notes for every Bun version.",
			},
		])
		expect(calls[0].url).toBe("https://html.duckduckgo.com/html/?q=bun%20frozen%20lockfile")
		expect(calls[0].headers["User-Agent"]).toMatch(/Mozilla\/5\.0/)
	})

	it("adds site: to the query and caps the hits at count", async () => {
		const { fetch, calls } = fakeFetch(DDG_HTML)
		const backend = createSearchBackend({ provider: "duckduckgo-html", fetch })
		const hits = await backend.search("install", { count: 1, site: "https://bun.sh/docs" })

		expect(hits).toHaveLength(1)
		expect(decodeURIComponent(calls[0].url)).toContain("q=install site:bun.sh")
	})

	it("returns nothing for a page without results", async () => {
		const { fetch } = fakeFetch('<html><body><div class="no-results">No results.</div></body></html>')
		const backend = createSearchBackend({ provider: "duckduckgo-html", fetch })
		await expect(backend.search("zzqx", { count: 5 })).resolves.toEqual([])
	})

	it("explains a bot check instead of reporting no results", async () => {
		const { fetch } = fakeFetch(
			'<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></body></html>',
		)
		const backend = createSearchBackend({ provider: "duckduckgo-html", fetch })
		await expect(backend.search("x", { count: 5 })).rejects.toThrow(/bot check.*searxng/s)
	})
})

describe("searxng", () => {
	it("calls <endpoint>/search with format=json and maps results", async () => {
		const { fetch, calls } = fakeFetch(SEARXNG_JSON)
		const backend = createSearchBackend({ provider: "searxng", fetch, endpoint: "https://searx.example.com/base" })
		const hits = await backend.search("vitest mock", { count: 5 })

		expect(hits).toEqual([
			{ title: "Mocking | Vitest", url: "https://vitest.dev/guide/mocking", snippet: "vi.mock replaces a module." },
			{ title: "vi.fn", url: "https://vitest.dev/api/vi", snippet: "Creates a spy." },
		])
		expect(calls[0].url).toBe("https://searx.example.com/base/search?q=vitest+mock&format=json")
	})

	it("asks for the endpoint setting when none is set", async () => {
		const { fetch } = fakeFetch(SEARXNG_JSON)
		const backend = createSearchBackend({ provider: "searxng", fetch })
		await expect(backend.search("x", { count: 5 })).rejects.toThrow(/plinycode\.webSearch\.endpoint/)
	})

	it("reports an answer that is not JSON", async () => {
		const { fetch } = fakeFetch("<html>login</html>")
		const backend = createSearchBackend({ provider: "searxng", fetch, endpoint: "https://searx.example.com" })
		await expect(backend.search("x", { count: 5 })).rejects.toThrow(/SearXNG answered with something other than JSON/)
	})
})

describe("brave", () => {
	it("sends the subscription token and strips the highlight markup", async () => {
		const { fetch, calls } = fakeFetch(BRAVE_JSON)
		const backend = createSearchBackend({ provider: "brave", fetch, getApiKey: async () => " key-123 " })
		const hits = await backend.search("node 22", { count: 1 })

		expect(hits).toEqual([
			{
				title: "Node.js 22 release notes",
				url: "https://nodejs.org/en/blog/release/v22.0.0",
				snippet: "What's new in Node.js 22 & more.",
			},
		])
		expect(calls[0].url).toBe("https://api.search.brave.com/res/v1/web/search?q=node%2022&count=1")
		expect(calls[0].headers["X-Subscription-Token"]).toBe("key-123")
	})

	it("points at the key command when no key is stored", async () => {
		const { fetch, calls } = fakeFetch(BRAVE_JSON)
		const backend = createSearchBackend({ provider: "brave", fetch, getApiKey: async () => undefined })
		await expect(backend.search("x", { count: 5 })).rejects.toThrow(/Set Web Search API Key/)
		expect(calls).toHaveLength(0)
	})
})

describe("google-cse", () => {
	it("passes key, cx and num and maps items", async () => {
		const { fetch, calls } = fakeFetch(GOOGLE_JSON)
		const backend = createSearchBackend({
			provider: "google-cse",
			fetch,
			googleCx: "cx-1",
			getApiKey: async () => "g-key",
		})
		const hits = await backend.search("TS2307", { count: 10 })

		expect(hits.map((hit) => hit.url)).toEqual([
			"https://stackoverflow.com/q/1",
			"https://www.typescriptlang.org/tsconfig#paths",
		])
		expect(calls[0].url).toBe("https://www.googleapis.com/customsearch/v1?key=g-key&cx=cx-1&q=TS2307&num=10")
	})

	it("asks for the search engine id when none is set", async () => {
		const { fetch } = fakeFetch(GOOGLE_JSON)
		const backend = createSearchBackend({ provider: "google-cse", fetch, getApiKey: async () => "g-key" })
		await expect(backend.search("x", { count: 5 })).rejects.toThrow(/plinycode\.webSearch\.googleCx/)
	})

	it("returns nothing when Google has no items", async () => {
		const { fetch } = fakeFetch(JSON.stringify({ kind: "customsearch#search" }))
		const backend = createSearchBackend({
			provider: "google-cse",
			fetch,
			googleCx: "cx-1",
			getApiKey: async () => "g-key",
		})
		await expect(backend.search("x", { count: 5 })).resolves.toEqual([])
	})
})

describe("errors", () => {
	it("throws the status and a short body on an HTTP error", async () => {
		const longBody = `{"error":{"code":403,"message":"API key not valid."}}${" padding".repeat(100)}`
		const { fetch } = fakeFetch(longBody, { status: 403, statusText: "Forbidden" })
		const backend = createSearchBackend({
			provider: "google-cse",
			fetch,
			googleCx: "cx-1",
			getApiKey: async () => "bad",
		})
		const error = await backend.search("x", { count: 5 }).catch((e: Error) => e)

		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toMatch(
			/^Google Programmable Search search failed: HTTP 403 Forbidden: \{"error":\{"code":403,"message":"API key not valid\."\}\}/,
		)
		expect((error as Error).message.length).toBeLessThan(300)
	})

	it("says the engine did not answer when the timeout fires", async () => {
		const fetch = (_url: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
			})
		const backend = createSearchBackend({ provider: "duckduckgo-html", fetch, timeoutMs: 20 })
		await expect(backend.search("x", { count: 5 })).rejects.toThrow("DuckDuckGo did not answer within 0.02 s.")
	})

	it("rethrows a cancellation as is", async () => {
		const controller = new AbortController()
		const fetch = (_url: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")))
				controller.abort()
			})
		const backend = createSearchBackend({ provider: "duckduckgo-html", fetch })
		await expect(backend.search("x", { count: 5, signal: controller.signal })).rejects.toThrow("cancelled")
	})

	it("wraps a network failure", async () => {
		const fetch = async () => {
			throw new TypeError("getaddrinfo ENOTFOUND html.duckduckgo.com")
		}
		const backend = createSearchBackend({ provider: "duckduckgo-html", fetch })
		await expect(backend.search("x", { count: 5 })).rejects.toThrow(
			"DuckDuckGo could not be reached: getaddrinfo ENOTFOUND html.duckduckgo.com",
		)
	})
})
