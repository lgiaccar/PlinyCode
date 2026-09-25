/** GitHub (github.com and GitHub Enterprise Server) through the REST API. */
import { type Auth, githubAuth } from "../auth"
import { DevOpsError } from "../errors"
import type { Remote } from "../repo"
import {
	type Check,
	type FailedStep,
	type Fetch,
	Http,
	type JobResult,
	type PipelineRun,
	type Provider,
	type PullRequest,
	type Result,
	type RunReport,
	type Status,
	tail,
} from "./types"

const TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z /gm

const RESULTS: Record<string, string> = {
	success: "success",
	failure: "failure",
	timed_out: "failure",
	startup_failure: "failure",
	cancelled: "cancelled",
	skipped: "skipped",
	neutral: "skipped",
	stale: "skipped",
	action_required: "action_required",
	error: "failure", // commit status API
}

const result = (value?: string | null): Result => (value ? (RESULTS[value] ?? value) : undefined)

const status = (value?: string | null): Status =>
	value === "completed" ? "completed" : value === "in_progress" ? "in_progress" : "queued"

/**
 * The `lines` lines ending at the last `##[error]` line of a job log.
 *
 * GitHub serves one log per job, and its tail is post-job cleanup; the useful
 * output is what the failing step printed just before the runner recorded the error.
 */
export function failureExcerpt(log: string, lines: number): string {
	const all = log.trimEnd().split(/\r?\n/)
	let last = -1
	all.forEach((line, i) => {
		if (line.includes("##[error]")) {
			last = i
		}
	})
	if (last < 0) {
		return tail(log, lines)
	}
	return all.slice(Math.max(0, last + 1 - lines), last + 1).join("\n")
}

export class GitHubProvider implements Provider {
	readonly kind = "GitHub"
	readonly maxBodyLength = 65536
	readonly repoUrl: string
	private readonly api: string
	private readonly http: Http

	constructor(
		private readonly remote: Remote,
		fetchImpl?: Fetch,
		auth: Auth = githubAuth(remote.host),
	) {
		const base = remote.host === "github.com" ? "https://api.github.com" : `https://${remote.host}/api/v3`
		this.api = `${base}/repos/${remote.owner}/${remote.repo}`
		this.repoUrl = `https://${remote.host}/${remote.owner}/${remote.repo}`
		this.http = new Http(auth, { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, fetchImpl)
	}

	private get<T = any>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
		return this.http.json<T>("GET", `${this.api}${path}`, { query })
	}

	private pr(d: any): PullRequest {
		return {
			id: d.number,
			title: d.title,
			body: d.body ?? "",
			state: d.merged_at ? "merged" : d.state,
			draft: Boolean(d.draft),
			sourceBranch: d.head.ref,
			targetBranch: d.base.ref,
			author: d.user?.login ?? "",
			url: d.html_url,
			headSha: d.head.sha,
		}
	}

	private run(d: any): PipelineRun {
		return {
			id: d.id,
			name: d.name || d.display_title || String(d.id),
			status: status(d.status),
			result: result(d.conclusion),
			branch: d.head_branch ?? "",
			commit: d.head_sha,
			url: d.html_url,
			started: d.run_started_at ?? d.created_at,
			finished: d.status === "completed" ? d.updated_at : undefined,
			event: d.event,
		}
	}

	async defaultBranch(): Promise<string> {
		return (await this.get("")).default_branch
	}

	async findOpenPr(branch: string): Promise<PullRequest | undefined> {
		const prs = await this.get<any[]>("/pulls", { head: `${this.remote.owner}:${branch}`, state: "open" })
		return prs.length ? this.pr(prs[0]) : undefined
	}

	async getPr(id: number): Promise<PullRequest> {
		return this.pr(await this.get(`/pulls/${id}`))
	}

	async createPr(title: string, body: string, source: string, target: string, draft: boolean): Promise<PullRequest> {
		const json = { title, body, head: source, base: target, draft }
		return this.pr(await this.http.json("POST", `${this.api}/pulls`, { json }))
	}

	async updatePr(id: number, title: string | undefined, body: string | undefined): Promise<PullRequest> {
		const json: Record<string, string> = {}
		if (title !== undefined) json.title = title
		if (body !== undefined) json.body = body
		return this.pr(await this.http.json("PATCH", `${this.api}/pulls/${id}`, { json }))
	}

	async listRuns(branch: string | undefined, pr: PullRequest | undefined, limit: number): Promise<PipelineRun[]> {
		const query: Record<string, string | number | undefined> = { per_page: limit }
		if (pr?.headSha) {
			query.head_sha = pr.headSha
		} else if (branch) {
			query.branch = branch
		}
		const data = await this.get("/actions/runs", query)
		return (data.workflow_runs ?? []).slice(0, limit).map((r: any) => this.run(r))
	}

	async runReport(runId: number, logLines: number): Promise<RunReport> {
		const run = this.run(await this.get(`/actions/runs/${runId}`))
		const jobsData: any[] = (await this.get(`/actions/runs/${runId}/jobs`, { filter: "latest", per_page: 100 })).jobs ?? []
		const jobs: JobResult[] = jobsData.map((j) => ({
			name: j.name,
			status: status(j.status),
			result: result(j.conclusion),
			url: j.html_url,
		}))
		const failures: FailedStep[] = []
		for (const j of jobsData) {
			if (result(j.conclusion) !== "failure") {
				continue
			}
			const steps = (j.steps ?? []).filter((s: any) => result(s.conclusion) === "failure").map((s: any) => s.name)
			failures.push({
				job: j.name,
				step: steps.join(", ") || "(job)",
				errors: await this.annotations(j.id),
				logTail: await this.jobLog(j.id, logLines),
			})
		}
		return { run, jobs, failures }
	}

	private async annotations(jobId: number): Promise<string[]> {
		// A job's id is also its check-run id; failure annotations carry the error messages.
		try {
			const notes = await this.get<any[]>(`/check-runs/${jobId}/annotations`, { per_page: 50 })
			return notes
				.filter((n) => n.annotation_level === "failure")
				.map((n) => n.message)
				.slice(0, 20)
		} catch (error) {
			if (error instanceof DevOpsError) return []
			throw error
		}
	}

	private async jobLog(jobId: number, lines: number): Promise<string | undefined> {
		if (lines <= 0) {
			return undefined
		}
		try {
			const resp = await this.http.request("GET", `${this.api}/actions/jobs/${jobId}/logs`)
			return failureExcerpt((await resp.text()).replace(TIMESTAMP, ""), lines)
		} catch (error) {
			// Logs expire or are not ready yet; the report is still useful without them.
			if (error instanceof DevOpsError) return undefined
			throw error
		}
	}

	async prChecks(pr: PullRequest): Promise<Check[]> {
		const sha = pr.headSha ?? (await this.getPr(pr.id)).headSha
		const runs: any[] = (await this.get(`/commits/${sha}/check-runs`, { per_page: 100 })).check_runs ?? []
		const checks: Check[] = runs.map((r) => ({
			name: r.name,
			status: status(r.status),
			result: result(r.conclusion),
			url: r.html_url,
		}))
		const statuses: any[] = (await this.get(`/commits/${sha}/status`)).statuses ?? []
		for (const s of statuses) {
			const done = s.state !== "pending"
			checks.push({
				name: s.context,
				status: done ? "completed" : "in_progress",
				result: done ? result(s.state) : undefined,
				url: s.target_url ?? undefined,
			})
		}
		return checks
	}
}
