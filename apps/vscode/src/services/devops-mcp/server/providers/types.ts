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
}

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
	url: string
	started?: string
	finished?: string
	event?: string
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
	updatePr(id: number, title: string | undefined, body: string | undefined): Promise<PullRequest>
	listRuns(branch: string | undefined, pr: PullRequest | undefined, limit: number): Promise<PipelineRun[]>
	runReport(runId: number, logLines: number): Promise<RunReport>
	prChecks(pr: PullRequest): Promise<Check[]>
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

export interface RequestOptions {
	query?: Query
	json?: unknown
	accept?: string
}

/** A thin fetch wrapper: adds auth, retries once on 401 and turns API errors into `DevOpsError`s. */
export class Http {
	constructor(
		private readonly auth: Auth,
		private readonly baseHeaders: Record<string, string>,
		private readonly fetchImpl: Fetch = globalThis.fetch,
	) {}

	async request(method: string, url: string, options: RequestOptions = {}): Promise<Response> {
		const target = new URL(url)
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined) {
				target.searchParams.set(key, String(value))
			}
		}
		const accept = options.accept ?? this.baseHeaders.Accept ?? "application/json"
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
			try {
				response = await this.fetchImpl(target, {
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
		if (resp.status >= 400) {
			throw new DevOpsError(`${method} ${target.pathname} -> HTTP ${resp.status}: ${await errorText(resp)}`)
		}
		// A rejected Azure DevOps credential is redirected to an HTML sign-in page with a 2xx status.
		if (accept.includes("json") && (resp.headers.get("content-type") ?? "").includes("text/html")) {
			throw new DevOpsError(`${method} ${target.pathname} returned a sign-in page; the credentials were not accepted.`)
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
