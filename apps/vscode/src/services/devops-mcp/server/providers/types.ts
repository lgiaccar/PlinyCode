import type { Auth } from "../auth"
import { DevOpsError } from "../errors"

export interface PullRequest {
	id: number
	title: string
	body: string
	/** open | closed | merged */
	state: string
	draft: boolean
	sourceBranch: string
	targetBranch: string
	author: string
	url: string
	headSha?: string
	/** Whether the PR merges cleanly into its target; only some calls report it (GitHub: `getPr`). */
	mergeState?: MergeState
	/** The PR comes from a fork, so its branch cannot be pushed to through this repository's remote. */
	fork?: boolean
}

/** `pending` while the server is still computing it. */
export type MergeState = "clean" | "conflicts" | "pending" | "unknown"

export type Status = "queued" | "in_progress" | "completed"
/** success | failure | cancelled | partial | skipped | action_required, or undefined while running. */
export type Result = string | undefined

export interface PipelineRun {
	id: number
	name: string
	status: Status
	result: Result
	branch: string
	commit?: string
	/** The pull request's source commit, when `commit` is a merge commit built for the PR (Azure DevOps). */
	headCommit?: string
	url: string
	started?: string
	finished?: string
	event?: string
	/** The workflow or pipeline definition the run belongs to; runs of one pipeline share it. */
	pipeline?: string
	pipelineId?: number
}

export interface JobResult {
	name: string
	status: Status
	result: Result
	url?: string
}

export interface FailedStep {
	job: string
	step: string
	errors: string[]
	logTail?: string
}

export interface RunReport {
	run: PipelineRun
	jobs: JobResult[]
	failures: FailedStep[]
}

export interface Check {
	name: string
	status: Status
	result: Result
	required?: boolean
	url?: string
}

export interface Provider {
	readonly kind: string
	readonly maxBodyLength: number
	readonly repoUrl: string
	defaultBranch(): Promise<string>
	findOpenPr(branch: string): Promise<PullRequest | undefined>
	getPr(id: number): Promise<PullRequest>
	createPr(title: string, body: string, source: string, target: string, draft: boolean): Promise<PullRequest>
	/** Changes only the fields given. `draft` false publishes a draft PR (ready for review); true makes it a draft again. */
	updatePr(id: number, title: string | undefined, body: string | undefined, draft?: boolean): Promise<PullRequest>
	listRuns(branch: string | undefined, pr: PullRequest | undefined, limit: number): Promise<PipelineRun[]>
	runReport(runId: number, logLines: number): Promise<RunReport>
	prChecks(pr: PullRequest): Promise<Check[]>
	/** Open pull requests, most recently updated first; `mine` keeps the signed-in user's. */
	listOpenPrs(options: { mine: boolean; limit: number }): Promise<PullRequest[]>
	/** The commit `branch` points at on the server, or undefined when the server has no such branch. */
	branchHead(branch: string): Promise<string | undefined>
	/** Requests left in the API's current rate-limit window, once a response has said. */
	readonly rateLimitRemaining?: number
}

export function checkBody(provider: Provider, body: string): void {
	if (body.length > provider.maxBodyLength) {
		throw new DevOpsError(
			`The description is ${body.length} characters; ${provider.kind} allows at most ${provider.maxBodyLength}. Shorten it (e.g. collapse detail into a summary) and try again.`,
		)
	}
}

export function tail(text: string, lines: number): string {
	return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n")
}

/** The subset of `fetch` the providers use (tests pass a fake). */
export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>

type Query = Record<string, string | number | undefined>

interface RequestOptions {
	query?: Query
	json?: unknown
	accept?: string
}

interface HttpOptions {
	/**
	 * Revalidate repeated JSON GETs with their ETag. GitHub answers an unchanged
	 * resource with 304, which does not count against the rate limit.
	 */
	etags?: boolean
}

interface CachedResponse {
	etag: string
	text: string
	contentType: string
}

/** JSON bodies kept for revalidation; the least recently stored goes first. */
const ETAG_CACHE_SIZE = 500

const MAX_REDIRECTS = 5

/** A thin fetch wrapper: adds auth, retries once on 401 and turns API errors into `DevOpsError`s. */
export class Http {
	private readonly cache?: Map<string, CachedResponse>
	/** Hosts that redirect every call to another host, learned from responses. */
	private readonly movedOrigins = new Map<string, string>()
	/** From the last response's `x-ratelimit-remaining` header (GitHub). */
	rateLimitRemaining?: number

	constructor(
		private readonly auth: Auth,
		private readonly baseHeaders: Record<string, string>,
		private readonly fetchImpl: Fetch = globalThis.fetch,
		options: HttpOptions = {},
	) {
		this.cache = options.etags ? new Map() : undefined
	}

	/**
	 * Follows redirects itself. `fetch` drops the Authorization header on a
	 * redirect to another host, which turns a renamed server (an Azure DevOps
	 * Server whose old host name redirects to its new one) into anonymous
	 * requests. A redirect that only changes the host keeps the credentials and
	 * is remembered, so later calls go straight to the new host; any other
	 * redirect to another host (e.g. a signed log download) is followed without
	 * them.
	 */
	private async send(target: URL, init: RequestInit & { headers: Record<string, string> }): Promise<Response> {
		let url = this.moved(target)
		let headers = init.headers
		for (let hops = 0; ; hops++) {
			const response = await this.fetchImpl(url, { ...init, headers, redirect: "manual" })
			const location = response.headers.get("location")
			if (
				response.status < 300 ||
				response.status >= 400 ||
				response.status === 304 ||
				!location ||
				hops >= MAX_REDIRECTS
			) {
				return response
			}
			const next = new URL(location, url)
			if (next.origin !== url.origin) {
				const sameResource = next.protocol === "https:" && next.pathname === url.pathname && next.search === url.search
				if (sameResource) {
					this.movedOrigins.set(url.origin, next.origin)
				} else {
					const { Authorization: _dropped, ...rest } = headers
					headers = rest
				}
			}
			url = next
		}
	}

	private moved(url: URL): URL {
		const origin = this.movedOrigins.get(url.origin)
		return origin ? new URL(url.href.replace(url.origin, origin)) : url
	}

	async request(method: string, url: string, options: RequestOptions = {}): Promise<Response> {
		const target = new URL(url)
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined) {
				target.searchParams.set(key, String(value))
			}
		}
		const accept = options.accept ?? this.baseHeaders.Accept ?? "application/json"
		const cacheable = this.cache !== undefined && method === "GET" && accept.includes("json")
		const cached = cacheable ? this.cache?.get(target.href) : undefined
		let response: Response | undefined
		for (const attempt of [1, 2]) {
			const headers: Record<string, string> = {
				...this.baseHeaders,
				Accept: accept,
				Authorization: await this.auth.header(),
				"User-Agent": "plinycode-devops-mcp",
			}
			if (options.json !== undefined) {
				headers["Content-Type"] = "application/json"
			}
			if (cached) {
				headers["If-None-Match"] = cached.etag
			}
			try {
				response = await this.send(target, {
					method,
					headers,
					body: options.json === undefined ? undefined : JSON.stringify(options.json),
					signal: AbortSignal.timeout(60_000),
				})
			} catch (error) {
				throw new DevOpsError(
					`${method} ${target.href} failed: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			if (response.status === 401 && attempt === 1) {
				this.auth.invalidate()
				continue
			}
			break
		}
		const resp = response as Response
		const remaining = Number.parseInt(resp.headers.get("x-ratelimit-remaining") ?? "", 10)
		if (Number.isFinite(remaining)) {
			this.rateLimitRemaining = remaining
		}
		if (resp.status === 304 && cached) {
			return new Response(cached.text, { status: 200, headers: { "content-type": cached.contentType } })
		}
		if (resp.status >= 400) {
			throw new DevOpsError(`${method} ${target.pathname} -> HTTP ${resp.status}: ${await errorText(resp)}`, resp.status)
		}
		// A rejected Azure DevOps credential is redirected to an HTML sign-in page with a 2xx status.
		if (accept.includes("json") && (resp.headers.get("content-type") ?? "").includes("text/html")) {
			throw new DevOpsError(`${method} ${target.pathname} returned a sign-in page; the credentials were not accepted.`)
		}
		const etag = resp.headers.get("etag")
		if (cacheable && etag && this.cache) {
			const text = await resp.text()
			const contentType = resp.headers.get("content-type") ?? "application/json"
			this.cache.delete(target.href)
			this.cache.set(target.href, { etag, text, contentType })
			if (this.cache.size > ETAG_CACHE_SIZE) {
				this.cache.delete(this.cache.keys().next().value as string)
			}
			return new Response(text, { status: resp.status, headers: { "content-type": contentType } })
		}
		return resp
	}

	async json<T = any>(method: string, url: string, options?: RequestOptions): Promise<T> {
		const resp = await this.request(method, url, options)
		const text = await resp.text()
		return (text ? JSON.parse(text) : undefined) as T
	}
}

async function errorText(resp: Response): Promise<string> {
	const text = await resp.text()
	try {
		const data = JSON.parse(text)
		if (data && typeof data === "object" && !Array.isArray(data)) {
			let message: string = data.message ?? data.Message ?? ""
			if (Array.isArray(data.errors) && data.errors.length) {
				const details = data.errors
					.map((e: any) => (e && typeof e === "object" ? (e.message ?? e.code ?? JSON.stringify(e)) : String(e)))
					.join("; ")
				message = `${message} (${details})`
			}
			return message || text.slice(0, 500)
		}
	} catch {
		// not JSON
	}
	return text.slice(0, 500)
}
