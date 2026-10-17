/**
 * `web_search`: a web search the extension runs itself, for models whose
 * provider has no native search (every Pliny model). The engine's own
 * `web_search` is a provider-native model tool (Anthropic's server-side
 * search) and is never offered through the Pliny gateway; this tool takes the
 * same name, so the chat row, the approval toggle (Use the browser) and the
 * Settings switch already apply to it.
 *
 * The answer is a short numbered list of titles, URLs and snippets. Snippets
 * are search-engine excerpts, not the page, so the result ends by sending the
 * model to `fetch_web_content` before it relies on one. See docs/agent-tools.md.
 */

import { supportsModelTool } from "@plinycode/llms"
import type { AgentTool, AgentToolContext } from "@plinycode/shared"
import type { SearchBackend, SearchHit } from "./web-search-backends"

const WEB_SEARCH_TOOL_NAME = "web_search"
const MAX_RESULTS = 10
const DEFAULT_RESULTS = 8
const SNIPPET_CHARS = 200
const TOOL_TIMEOUT_MS = 30_000
const READ_FIRST_LINE = "Read a page with fetch_web_content before relying on it."

/** The user's web search settings, resolved by the host when a session starts. */
export interface WebSearchSetup {
	backend: SearchBackend
	/** Hits returned when the model does not ask for a number (`plinycode.webSearch.maxResults`). */
	maxResults: number
}

interface WebSearchInput {
	query?: string
	site?: string
	count?: number
}

function clampCount(value: unknown, fallback: number): number {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
	if (!Number.isFinite(number)) {
		return Math.min(Math.max(Math.round(fallback), 1), MAX_RESULTS)
	}
	return Math.min(Math.max(Math.round(number), 1), MAX_RESULTS)
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "")
	} catch {
		return ""
	}
}

function shorten(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`
}

function formatHits(hits: readonly SearchHit[]): string {
	const lines: string[] = []
	hits.forEach((hit, index) => {
		const host = hostOf(hit.url)
		lines.push(`${index + 1}. ${hit.title}${host ? ` — ${host}` : ""}`)
		lines.push(`   ${hit.url}`)
		if (hit.snippet) {
			lines.push(`   ${shorten(hit.snippet, SNIPPET_CHARS)}`)
		}
	})
	lines.push("", READ_FIRST_LINE)
	return lines.join("\n")
}

function createWebSearchTool(setup: WebSearchSetup): AgentTool {
	return {
		name: WEB_SEARCH_TOOL_NAME,
		description:
			"Search the public web for documentation, error messages, release notes, API references and other " +
			"information that is not in the workspace. Returns a numbered list of titles, URLs and short snippets. " +
			"Snippets are excerpts, not the page: call fetch_web_content on the results worth reading before you " +
			"rely on them. Use `site` to search one site (e.g. docs.python.org). Write queries the way you would " +
			"type them into a search engine: a few specific words, the exact error text in quotes.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "What to search for." },
				site: { type: "string", description: "Only return pages from this site, e.g. learn.microsoft.com." },
				count: { type: "number", description: `How many results to return (1-${MAX_RESULTS}).` },
			},
			required: ["query"],
		},
		executionMode: "parallel",
		retryable: true,
		maxRetries: 1,
		timeoutMs: TOOL_TIMEOUT_MS,
		async execute(rawInput: unknown, context: AgentToolContext): Promise<string> {
			const input = (rawInput ?? {}) as WebSearchInput
			const query = typeof input.query === "string" ? input.query.trim() : ""
			if (!query) {
				throw new Error("web_search needs a `query`.")
			}
			const site = typeof input.site === "string" && input.site.trim() ? input.site.trim() : undefined
			const count = clampCount(input.count, setup.maxResults)
			const hits = await setup.backend.search(query, { count, site, signal: context.signal })
			if (hits.length === 0) {
				return (
					`No results for "${query}"${site ? ` on ${site}` : ""}. Rephrase the query: fewer or more general ` +
					`words, without quotes${site ? ", or without `site`" : ""}.`
				)
			}
			return formatHits(hits.slice(0, count))
		},
	}
}

/**
 * The `web_search` tool for a session, or none: when the user turned web
 * search off (`setup` undefined), or when the provider searches natively, in
 * which case the engine offers its own `web_search` model tool and this one
 * would only shadow it.
 */
export function createWebSearchTools(options: {
	setup: WebSearchSetup | undefined
	providerId?: string
	modelId?: string
}): AgentTool[] {
	if (!options.setup) {
		return []
	}
	if (options.providerId && supportsModelTool({ providerId: options.providerId, modelId: options.modelId }, "web_search")) {
		return []
	}
	return [createWebSearchTool({ ...options.setup, maxResults: clampCount(options.setup.maxResults, DEFAULT_RESULTS) })]
}
