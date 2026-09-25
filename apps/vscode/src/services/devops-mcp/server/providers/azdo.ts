/** Azure DevOps Services (dev.azure.com) Repos + Pipelines through the REST API (7.1). */
import { type Auth, adoAuth } from "../auth"
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

const API_VERSION = "7.1"

const RESULTS: Record<string, string | undefined> = {
	succeeded: "success",
	succeededWithIssues: "partial",
	partiallySucceeded: "partial",
	failed: "failure",
	canceled: "cancelled",
	abandoned: "cancelled",
	skipped: "skipped",
	none: undefined,
}

const POLICY: Record<string, [Status, Result]> = {
	approved: ["completed", "success"],
	rejected: ["completed", "failure"],
	broken: ["completed", "failure"],
	notApplicable: ["completed", "skipped"],
	running: ["in_progress", undefined],
	queued: ["queued", undefined],
}

const PR_STATUS: Record<string, [Status, Result]> = {
	succeeded: ["completed", "success"],
	failed: ["completed", "failure"],
	error: ["completed", "failure"],
	notApplicable: ["completed", "skipped"],
	pending: ["in_progress", undefined],
	notSet: ["queued", undefined],
}

const result = (value?: string | null): Result => (value ? (value in RESULTS ? RESULTS[value] : value) : undefined)

const status = (value?: string | null): Status =>
	value === "completed" ? "completed" : value === "inProgress" || value === "cancelling" ? "in_progress" : "queued"

const short = (ref?: string | null) => (ref ?? "").replace(/^refs\/heads\//, "")

export class AzureDevOpsProvider implements Provider {
	readonly kind = "Azure DevOps"
	// Azure DevOps rejects pull request descriptions longer than 4000 characters.
	readonly maxBodyLength = 4000
	readonly repoUrl: string
	private readonly projectUrl: string
	private readonly http: Http
	private repoInfo?: Promise<any>

	constructor(
		private readonly remote: Remote,
		fetchImpl?: Fetch,
		auth: Auth = adoAuth(),
	) {
		const orgUrl = `https://dev.azure.com/${encodeURIComponent(remote.owner)}`
		this.projectUrl = `${orgUrl}/${encodeURIComponent(remote.project ?? "")}`
		this.repoUrl = `${this.projectUrl}/_git/${encodeURIComponent(remote.repo)}`
		this.http = new Http(auth, { Accept: "application/json" }, fetchImpl)
	}

	private api<T = any>(method: string, path: string, query: Record<string, string | number | undefined> = {}, json?: unknown) {
		return this.http.json<T>(method, `${this.projectUrl}/_apis/${path}`, {
			query: { "api-version": API_VERSION, ...query },
			json,
		})
	}

	private repo(): Promise<any> {
		if (!this.repoInfo) {
			this.repoInfo = this.api("GET", `git/repositories/${encodeURIComponent(this.remote.repo)}`)
			// Do not cache a failure (e.g. before the user has signed in).
			this.repoInfo.catch(() => {
				this.repoInfo = undefined
			})
		}
		return this.repoInfo
	}

	private async prPath(suffix = ""): Promise<string> {
		return `git/repositories/${(await this.repo()).id}/pullrequests${suffix}`
	}

	private pr(d: any): PullRequest {
		const states: Record<string, string> = { active: "open", completed: "merged", abandoned: "closed" }
		return {
			id: d.pullRequestId,
			title: d.title ?? "",
			body: d.description ?? "",
			state: states[d.status] ?? d.status ?? "",
			draft: Boolean(d.isDraft),
			sourceBranch: short(d.sourceRefName),
			targetBranch: short(d.targetRefName),
			author: d.createdBy?.displayName ?? "",
			url: `${this.repoUrl}/pullrequest/${d.pullRequestId}`,
			headSha: d.lastMergeSourceCommit?.commitId,
		}
	}

	private run(d: any): PipelineRun {
		return {
			id: d.id,
			name: `${d.definition?.name ?? "build"} #${d.buildNumber ?? d.id}`,
			status: status(d.status),
			result: d.status === "completed" ? result(d.result) : undefined,
			branch: short(d.sourceBranch),
			commit: d.sourceVersion,
			url: d._links?.web?.href ?? `${this.projectUrl}/_build/results?buildId=${d.id}`,
			started: d.startTime ?? d.queueTime,
			finished: d.finishTime,
			event: d.reason,
		}
	}

	async defaultBranch(): Promise<string> {
		const branch = short((await this.repo()).defaultBranch)
		if (!branch) {
			throw new DevOpsError("The Azure DevOps repository has no default branch yet.")
		}
		return branch
	}

	async findOpenPr(branch: string): Promise<PullRequest | undefined> {
		const data = await this.api("GET", await this.prPath(), {
			"searchCriteria.sourceRefName": `refs/heads/${branch}`,
			"searchCriteria.status": "active",
		})
		const prs: any[] = data.value ?? []
		return prs.length ? this.pr(prs[0]) : undefined
	}

	async getPr(id: number): Promise<PullRequest> {
		return this.pr(await this.api("GET", await this.prPath(`/${id}`)))
	}

	async createPr(title: string, body: string, source: string, target: string, draft: boolean): Promise<PullRequest> {
		const json = {
			sourceRefName: `refs/heads/${source}`,
			targetRefName: `refs/heads/${target}`,
			title,
			description: body,
			isDraft: draft,
		}
		return this.pr(await this.api("POST", await this.prPath(), {}, json))
	}

	async updatePr(id: number, title: string | undefined, body: string | undefined): Promise<PullRequest> {
		const json: Record<string, string> = {}
		if (title !== undefined) json.title = title
		if (body !== undefined) json.description = body
		return this.pr(await this.api("PATCH", await this.prPath(`/${id}`), {}, json))
	}

	async listRuns(branch: string | undefined, pr: PullRequest | undefined, limit: number): Promise<PipelineRun[]> {
		const repo = await this.repo()
		const query: Record<string, string | number | undefined> = {
			$top: limit,
			queryOrder: "queueTimeDescending",
			repositoryId: repo.id,
			repositoryType: "TfsGit",
		}
		if (pr) {
			query.branchName = `refs/pull/${pr.id}/merge`
		} else if (branch) {
			query.branchName = `refs/heads/${branch}`
		}
		const data = await this.api("GET", "build/builds", query)
		return (data.value ?? []).map((b: any) => this.run(b))
	}

	async runReport(runId: number, logLines: number): Promise<RunReport> {
		const run = this.run(await this.api("GET", `build/builds/${runId}`))
		const timeline = (await this.api("GET", `build/builds/${runId}/timeline`)) ?? {}
		const records: any[] = [...(timeline.records ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
		const byId = new Map(records.map((r) => [r.id, r]))
		const jobOf = (rec: any): string => {
			let cur = rec
			while (cur && cur.type !== "Job") {
				cur = byId.get(cur.parentId)
			}
			return cur?.name ?? "(unknown job)"
		}

		const jobs: JobResult[] = records
			.filter((r) => r.type === "Job")
			.map((r) => ({
				name: r.name,
				status: status(r.state),
				result: result(r.result),
				url: `${run.url}&view=logs&j=${r.id}`,
			}))
		const failures: FailedStep[] = []
		for (const r of records) {
			if (r.type !== "Task" || r.result !== "failed") {
				continue
			}
			const errors = (r.issues ?? [])
				.filter((i: any) => i.type === "error")
				.map((i: any) => i.message)
				.slice(0, 20)
			failures.push({ job: jobOf(r), step: r.name, errors, logTail: await this.log(runId, r.log?.id, logLines) })
		}
		return { run, jobs, failures }
	}

	private async log(runId: number, logId: number | undefined, lines: number): Promise<string | undefined> {
		if (logId === undefined || lines <= 0) {
			return undefined
		}
		try {
			const resp = await this.http.request("GET", `${this.projectUrl}/_apis/build/builds/${runId}/logs/${logId}`, {
				query: { "api-version": API_VERSION },
				accept: "text/plain",
			})
			return tail(await resp.text(), lines)
		} catch (error) {
			if (error instanceof DevOpsError) return undefined
			throw error
		}
	}

	async prChecks(pr: PullRequest): Promise<Check[]> {
		const repo = await this.repo()
		const artifactId = `vstfs:///CodeReview/CodeReviewId/${repo.project.id}/${pr.id}`
		const evaluations = await this.api("GET", "policy/evaluations", { artifactId, "api-version": "7.1-preview.1" })
		const checks: Check[] = (evaluations.value ?? []).map((ev: any) => {
			const cfg = ev.configuration ?? {}
			const [evStatus, evResult] = POLICY[ev.status] ?? ["queued", undefined]
			const buildId = ev.context?.buildId
			return {
				name: cfg.settings?.displayName ?? cfg.type?.displayName ?? "policy",
				status: evStatus,
				result: evResult,
				required: Boolean(cfg.isBlocking),
				url: buildId ? `${this.projectUrl}/_build/results?buildId=${buildId}` : undefined,
			}
		})

		// External CI systems report through PR statuses; keep only the newest per context.
		const statuses: any[] = (await this.api("GET", await this.prPath(`/${pr.id}/statuses`))).value ?? []
		const latest = new Map<string, any>()
		for (const s of [...statuses].sort((a, b) => (a.id ?? 0) - (b.id ?? 0))) {
			const name = [s.context?.genre, s.context?.name].filter(Boolean).join("/")
			latest.set(name, s)
		}
		for (const [name, s] of latest) {
			const [sStatus, sResult] = PR_STATUS[s.state] ?? ["queued", undefined]
			checks.push({ name, status: sStatus, result: sResult, url: s.targetUrl })
		}
		return checks
	}
}
