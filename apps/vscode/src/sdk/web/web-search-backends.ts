/**
 * The search engines behind the `web_search` tool (web-search-tool.ts).
 *
 * Pliny models have no provider-native web search, so the extension runs the
 * query itself and hands the model titles, URLs and snippets. Which engine
 * answers is a setting (`plinycode.webSearch.provider`):
 *
 * - `duckduckgo-html` (the default): DuckDuckGo's script-free results page,
 *   scraped with cheerio. Needs no key, but it is a page, not an API: a
 *   markup change or a bot check breaks it.
 * - `searxng`: a SearXNG instance's JSON API (`format=json` must be enabled on
 *   the instance). The recommended choice for a team: one self-hosted
 *   instance, no key, no scraping.
 * - `brave`: the Brave Search API, with a subscription token.
 * - `google-cse`: Google Programmable Search (Custom Search JSON API), with an
 *   API key and a search engine id (`cx`).
 *
 * Nothing here imports `vscode`: the host supplies the settings, the API key
 * and a proxy-aware `fetch` (hosts/vscode/web-search-settings.ts), and the
 * tests a recorded one.
 */

import * as cheerio from "cheerio"

export const WEB_SEARCH_PROVIDERS = ["duckduckgo-html", "searxng", "brave", "google-cse"] as const
export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDERS)[number]

export interface SearchHit {
	title: string
	url: string
	snippet: string
}

interface SearchOptions {
	/** How many hits to return at most. */
	count: number
	/** Limit the search to one site (a host name such as `docs.python.org`). */
	site?: string
	signal?: AbortSignal
}

export interface SearchBackend {
	readonly id: WebSearchProviderId
	search(query: string, options: SearchOptions): Promise<SearchHit[]>
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

interface SearchBackendConfig {
	provider: WebSearchProviderId
	/** The proxy- and CA-aware fetch the host uses for everything else. */
	fetch: FetchLike
	/** SearXNG base URL, e.g. `https://searx.example.com`. */
	endpoint?: string
	/** Google Programmable Search engine id. */
	googleCx?: string
	/** Brave or Google API key, read at search time so a newly stored key applies at once. */
	getApiKey?: () => Promise<string | undefined>
	/** Per-request timeout; 15 s unless a test shortens it. */
	timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const ERROR_BODY_CHARS = 200
/** A current desktop browser: DuckDuckGo serves bots a different (or no) page. */
const DESKTOP_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
const SET_KEY_HINT = 'Run "PlinyCode: Set Web Search API Key" to store one.'

const PROVIDER_LABELS: Record<WebSearchProviderId, string> = {
	"duckduckgo-html": "DuckDuckGo",
	searxng: "SearXNG",
	brave: "Brave Search",
	"google-cse": "Google Programmable Search",
}

export function createSearchBackend(config: SearchBackendConfig): SearchBackend {
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const label = PROVIDER_LABELS[config.provider]
	const get = (url: string, headers: Record<string, string>, signal: AbortSignal | undefined) =>
		fetchText(config.fetch, url, { headers, label, timeoutMs, signal })

	switch (config.provider) {
		case "duckduckgo-html":
			return {
				id: config.provider,
				async search(query, options) {
					const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(withSite(query, options.site))}`
					const html = await get(
						url,
						{ "User-Agent": DESKTOP_USER_AGENT, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
						options.signal,
					)
					return parseDuckDuckGoHtml(html).slice(0, options.count)
				},
			}
		case "searxng":
			return {
				id: config.provider,
				async search(query, options) {
					const base = config.endpoint?.trim()
					if (!base) {
						throw new Error(
							"SearXNG needs a base URL: set plinycode.webSearch.endpoint (e.g. https://searx.example.com).",
						)
					}
					const url = new URL("search", base.endsWith("/") ? base : `${base}/`)
					url.searchParams.set("q", withSite(query, options.site))
					url.searchParams.set("format", "json")
					const body = parseJson(await get(url.href, { Accept: "application/json" }, options.signal), label)
					const results = arrayField(body, "results")
					return toHits(results, "title", "url", "content", options.count)
				},
			}
		case "brave":
			return {
				id: config.provider,
				async search(query, options) {
					const key = (await config.getApiKey?.())?.trim()
					if (!key) {
						throw new Error(`Brave Search needs an API key. ${SET_KEY_HINT}`)
					}
					const url =
						"https://api.search.brave.com/res/v1/web/search" +
						`?q=${encodeURIComponent(withSite(query, options.site))}&count=${options.count}`
					const body = parseJson(
						await get(url, { Accept: "application/json", "X-Subscription-Token": key }, options.signal),
						label,
					)
					const web = isRecord(body) ? body.web : undefined
					return toHits(arrayField(web, "results"), "title", "url", "description", options.count)
				},
			}
		case "google-cse":
			return {
				id: config.provider,
				async search(query, options) {
					const key = (await config.getApiKey?.())?.trim()
					if (!key) {
						throw new Error(`Google Programmable Search needs an API key. ${SET_KEY_HINT}`)
					}
					const cx = config.googleCx?.trim()
					if (!cx) {
						throw new Error("Google Programmable Search needs a search engine id: set plinycode.webSearch.googleCx.")
					}
					const url =
						"https://www.googleapis.com/customsearch/v1" +
						`?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}` +
						`&q=${encodeURIComponent(withSite(query, options.site))}&num=${Math.min(options.count, 10)}`
					const body = parseJson(await get(url, { Accept: "application/json" }, options.signal), label)
					return toHits(arrayField(body, "items"), "title", "link", "snippet", options.count)
				},
			}
	}
}

function withSite(query: string, site: string | undefined): string {
	const host = site
		?.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/\/.*$/, "")
	return host ? `${query} site:${host}` : query
}

/** GETs `url` within the timeout and returns the body; a non-2xx answer throws with its status and a short body. */
async function fetchText(
	fetchImpl: FetchLike,
	url: string,
	options: { headers: Record<string, string>; label: string; timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
	const timeout = AbortSignal.timeout(options.timeoutMs)
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
	let response: Response
	try {
		response = await fetchImpl(url, { method: "GET", headers: options.headers, signal })
	} catch (error) {
		if (options.signal?.aborted) {
			throw error
		}
		if (timeout.aborted) {
			throw new Error(`${options.label} did not answer within ${options.timeoutMs / 1000} s.`)
		}
		throw new Error(`${options.label} could not be reached: ${error instanceof Error ? error.message : String(error)}`)
	}
	const text = await response.text()
	if (!response.ok) {
		const body = text.replace(/\s+/g, " ").trim().slice(0, ERROR_BODY_CHARS)
		const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`
		throw new Error(`${options.label} search failed: ${status}${body ? `: ${body}` : ""}`)
	}
	return text
}

function parseDuckDuckGoHtml(html: string): SearchHit[] {
	const $ = cheerio.load(html)
	const hits: SearchHit[] = []
	const seen = new Set<string>()
	$(".result").each((_, element) => {
		const result = $(element)
		if (result.hasClass("result--ad")) {
			return
		}
		const link = result.find(".result__a").first()
		const url = unwrapDuckDuckGoUrl(link.attr("href") ?? "")
		const title = collapse(link.text())
		if (!url || !title || seen.has(url)) {
			return
		}
		seen.add(url)
		hits.push({ title, url, snippet: collapse(result.find(".result__snippet").first().text()) })
	})
	if (hits.length === 0 && /anomaly|captcha|challenge-form/i.test(html) && $(".no-results").length === 0) {
		throw new Error(
			"DuckDuckGo refused the query with a bot check. Try again later, or switch plinycode.webSearch.provider " +
				"to searxng, brave or google-cse.",
		)
	}
	return hits
}

/**
 * DuckDuckGo links its results through a redirect, `//duckduckgo.com/l/?uddg=<encoded url>&rut=…`.
 * Returns the target, the href itself when it is already a plain http(s) URL,
 * and "" for anything else (ads go through `y.js`).
 */
function unwrapDuckDuckGoUrl(href: string): string {
	if (!href) {
		return ""
	}
	try {
		const url = new URL(href, "https://duckduckgo.com")
		if (url.hostname.endsWith("duckduckgo.com")) {
			const target = url.pathname === "/l/" ? url.searchParams.get("uddg") : null
			return target && /^https?:\/\//i.test(target) ? target : ""
		}
		return /^https?:$/.test(url.protocol) ? url.href : ""
	} catch {
		return ""
	}
}

function parseJson(text: string, label: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		throw new Error(`${label} answered with something other than JSON: ${collapse(text).slice(0, ERROR_BODY_CHARS)}`)
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function arrayField(value: unknown, field: string): unknown[] {
	const entry = isRecord(value) ? value[field] : undefined
	return Array.isArray(entry) ? entry : []
}

function toHits(items: unknown[], titleKey: string, urlKey: string, snippetKey: string, count: number): SearchHit[] {
	const hits: SearchHit[] = []
	const seen = new Set<string>()
	for (const item of items) {
		if (!isRecord(item)) {
			continue
		}
		const url = typeof item[urlKey] === "string" ? item[urlKey].trim() : ""
		if (!/^https?:\/\//i.test(url) || seen.has(url)) {
			continue
		}
		seen.add(url)
		const title = stripTags(typeof item[titleKey] === "string" ? item[titleKey] : "") || url
		hits.push({ title, url, snippet: stripTags(typeof item[snippetKey] === "string" ? item[snippetKey] : "") })
		if (hits.length >= count) {
			break
		}
	}
	return hits
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

/** Brave and Google mark the matched words with `<strong>`/`<b>` and escape entities. */
function stripTags(text: string): string {
	return collapse(
		text.replace(/<[^>]*>/g, "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
			if (entity[0] === "#") {
				const code =
					entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))
				return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
			}
			return ENTITIES[entity.toLowerCase()] ?? match
		}),
	)
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim()
}
