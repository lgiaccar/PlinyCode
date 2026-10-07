import type { Auth } from "../auth"
import type { Fetch } from "../providers/types"

type Route = { status: number; body?: unknown; text?: string; contentType?: string; etag?: string }

/** Routes `METHOD path` to canned responses and records every request. */
export class FakeApi {
	readonly routes = new Map<string, Route>()
	readonly requests: { method: string; url: URL; headers: Record<string, string>; body?: string }[] = []

	on(method: string, path: string, body?: unknown, status = 200): this {
		this.routes.set(`${method} ${path}`, { status, body })
		return this
	}

	/** A JSON route with an ETag: a request that sends the same tag in If-None-Match gets a bodiless 304. */
	onTagged(method: string, path: string, body: unknown, etag: string): this {
		this.routes.set(`${method} ${path}`, { status: 200, body, etag })
		return this
	}

	onText(method: string, path: string, text: string, contentType = "text/plain", status = 200): this {
		this.routes.set(`${method} ${path}`, { status, text, contentType })
		return this
	}

	readonly fetch: Fetch = async (input, init) => {
		const url = new URL(String(input))
		const headers = { ...(init?.headers as Record<string, string>) }
		const method = init?.method ?? "GET"
		this.requests.push({ method, url, headers, body: init?.body as string | undefined })
		const route = this.routes.get(`${method} ${decodeURIComponent(url.pathname)}`)
		if (!route) {
			return new Response(JSON.stringify({ message: `no fake route for ${method} ${url.pathname}` }), { status: 404 })
		}
		if (route.text !== undefined) {
			return new Response(route.text, {
				status: route.status,
				headers: { "content-type": route.contentType ?? "text/plain" },
			})
		}
		if (route.etag && headers["If-None-Match"] === route.etag) {
			return new Response(null, { status: 304, headers: { etag: route.etag, "x-ratelimit-remaining": "4999" } })
		}
		return new Response(JSON.stringify(route.body ?? null), {
			status: route.status,
			headers: { "content-type": "application/json", ...(route.etag ? { etag: route.etag } : {}) },
		})
	}

	last(method: string) {
		const matching = this.requests.filter((r) => r.method === method)
		return matching[matching.length - 1]
	}

	lastJson(method: string): unknown {
		return JSON.parse(this.last(method).body ?? "null")
	}
}

export const staticAuth = (header = "Bearer test-token"): Auth => ({
	header: async () => header,
	invalidate: () => {},
})
