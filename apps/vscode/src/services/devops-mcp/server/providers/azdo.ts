/** Azure DevOps Services (dev.azure.com) Repos + Pipelines through the REST API (7.1). */

import { type PipelineSchema, parsePipelineInputs } from "../../pipelines/pipeline-inputs"
import { type Auth, adoAuth } from "../auth"
import { DevOpsError } from "../errors"
import type { Remote } from "../repo"
import {
	type Check,
	type FailedStep,
	type Fetch,
	Http,
	type JobResult,
	type MergeState,
	type PipelineDefinition,
	type PipelineDispatch,
	type PipelineProvider,
	type PipelineRun,
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

const MERGE_STATES: Record<string, MergeState> = {
	conflicts: "conflicts",
	succeeded: "clean",
	queued: "pending",
	notSet: "pending",
	rejectedByPolicy: "unknown",
	failure: "unknown",
}

export class AzureDevOpsProvider implements PipelineProvider {
	readonly kind = "Azure DevOps"
	// Azure DevOps rejects pull request descriptions longer than 4000 characters.
	readonly maxBodyLength = 4000
	readonly repoUrl: string
	private readonly orgUrl: string
	private readonly projectUrl: string
	private readonly http: Http
	private repoInfo?: Promise<any>
	private userId?: Promise<string>
	private readonly mergeSources = new Map<string, Promise<string | undefined>>()

	constructor(
		private readonly remote: Remote,
		fetchImpl?: Fetch,
		auth: Auth = adoAuth(),
	) {
		// On-premises Azure DevOps Server: {origin}/{collection path}/{project}, where the collection path may
		// itself have multiple segments (e.g. "tfs/Some_Collection") that must stay separate path segments,
		// not one encoded blob. Cloud: https://dev.azure.com/{org}/{project}.
		this.orgUrl = remote.origin
			? `${remote.origin}/${(remote.collection ?? "").split("/").map(encodeURIComponent).join("/")}`
			: `https://dev.azure.com/${encodeURIComponent(remote.owner)}`
		this.projectUrl = `${this.orgUrl}/${encodeURIComponent(remote.project ?? "")}`
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
			mergeState: d.mergeStatus ? (MERGE_STATES[d.mergeStatus] ?? "unknown") : undefined,
			fork: Boolean(d.forkSource),
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
			headCommit: d.triggerInfo?.["pr.sourceSha"],
			url: d._links?.web?.href ?? `${this.projectUrl}/_build/results?buildId=${d.id}`,
			started: d.startTime ?? d.queueTime,
			finished: d.finishTime,
			event: d.reason,
			pipeline: d.definition?.name,
			pipelineId: d.definition?.id,
		}
	}

	async defaultBranch(): Promise<string> {
		const branch = short((await this.repo()).defaultBranch)
		if (!branch) {
			throw new DevOpsError("The Azure DevOps repository has no default branch yet.")
		}
		return branch
	}

	async listPipelines(): Promise<PipelineDefinition[]> {
		const repo = await this.repo()
		const pipelines: PipelineDefinition[] = []
		let continuation: string | undefined
		do {
			const response = await this.http.request("GET", `${this.projectUrl}/_apis/build/definitions`, {
				query: {
					"api-version": API_VERSION,
					repositoryId: repo.id,
					repositoryType: "TfsGit",
					includeAllProperties: "true",
					$top: 100,
					continuationToken: continuation,
				},
			})
			const data = (await response.json()) as { value?: any[] }
			pipelines.push(
				...(data.value ?? [])
					.filter((definition) => definition.process?.type === 2 && definition.queueStatus === "enabled")
					.map((definition) => ({
						id: definition.id,
						name: definition.name,
						url: definition._links?.web?.href ?? `${this.projectUrl}/_build?definitionId=${definition.id}`,
					})),
			)
			continuation = response.headers.get("x-ms-continuationtoken") ?? undefined
		} while (continuation)
		return pipelines
	}

	async pipelineInputs(pipelineId: number, ref: string): Promise<PipelineSchema> {
		const repo = await this.repo()
		const definition = await this.api("GET", `build/definitions/${pipelineId}`)
		if (definition.process?.type !== 2 || String(definition.repository?.id).toLowerCase() !== String(repo.id).toLowerCase()) {
			throw new DevOpsError("Select a YAML pipeline connected to this workspace repository.")
		}
		if (definition.queueStatus !== "enabled") throw new DevOpsError("This pipeline does not allow new runs.")
		const content = await this.api("GET", `git/repositories/${repo.id}/items`, {
			path: definition.process.yamlFilename,
			includeContent: "true",
			"versionDescriptor.version": ref.replace(/^refs\/(heads|tags)\//, ""),
			"versionDescriptor.versionType": ref.startsWith("refs/tags/") ? "tag" : "branch",
		})
		if (typeof content.content !== "string") throw new DevOpsError("Azure DevOps did not return the pipeline YAML.")
		return parsePipelineInputs(content.content, "ado", content.commitId)
	}

	async queuePipeline(pipelineId: number, ref: string, inputs: Record<string, unknown>): Promise<PipelineDispatch> {
		const data = await this.api(
			"POST",
			`pipelines/${pipelineId}/runs`,
			{},
			{
				templateParameters: inputs,
				resources: { repositories: { self: { refName: ref.startsWith("refs/") ? ref : `refs/heads/${ref}` } } },
			},
		)
		if (!Number.isSafeInteger(data?.id) || data.id <= 0)
			throw new DevOpsError("Azure DevOps accepted the request but did not return a run ID.")
		return { runId: data.id, url: data._links?.web?.href ?? `${this.projectUrl}/_build/results?buildId=${data.id}` }
	}

	async getRun(runId: number): Promise<PipelineRun> {
		return this.run(await this.api("GET", `build/builds/${runId}`))
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

	async listOpenPrs({ mine, limit }: { mine: boolean; limit: number }): Promise<PullRequest[]> {
		const data = await this.api("GET", await this.prPath(), {
			"searchCriteria.status": "active",
			"searchCriteria.creatorId": mine ? await this.me() : undefined,
			$top: limit,
		})
		return (data.value ?? []).slice(0, limit).map((d: any) => this.pr(d))
	}

	/** The signed-in user's id, from the organization's (or collection's) connection data. */
	private me(): Promise<string> {
		if (!this.userId) {
			this.userId = this.http.json("GET", `${this.orgUrl}/_apis/connectionData`).then((data) => {
				const id = data?.authenticatedUser?.id
				if (!id) throw new DevOpsError("Azure DevOps did not say who is signed in.")
				return String(id)
			})
			this.userId.catch(() => {
				this.userId = undefined
			})
		}
		return this.userId
	}

	async branchHead(branch: string): Promise<string | undefined> {
		const data = await this.api("GET", `git/repositories/${(await this.repo()).id}/refs`, { filter: `heads/${branch}` })
		// `filter` matches a prefix, so `feature` would also list `feature-2`.
		const ref = (data.value ?? []).find((r: any) => r.name === `refs/heads/${branch}`)
		return ref?.objectId
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

	async updatePr(id: number, title: string | undefined, body: string | undefined, draft?: boolean): Promise<PullRequest> {
		const json: Record<string, string | boolean> = {}
		if (title !== undefined) json.title = title
		if (body !== undefined) json.description = body
		if (draft !== undefined) json.isDraft = draft
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
		const runs: PipelineRun[] = (data.value ?? []).map((b: any) => this.run(b))
		// Azure DevOps Server (on-premises) leaves `pr.sourceSha` out of a PR build's trigger info, so only the
		// merge commit it built is known. That commit's second parent is the PR's source commit.
		await Promise.all(
			runs
				.filter((r) => !r.headCommit && r.commit && r.branch.startsWith("refs/pull/"))
				.map(async (r) => {
					r.headCommit = await this.mergeSource(repo.id, r.commit as string)
				}),
		)
		return runs
	}

	/** The source (second parent) of a PR merge commit; commits never change, so answers are kept. */
	private mergeSource(repoId: string, sha: string): Promise<string | undefined> {
		let source = this.mergeSources.get(sha)
		if (!source) {
			source = this.api("GET", `git/repositories/${repoId}/commits/${sha}`).then(
				(c) => (Array.isArray(c?.parents) && c.parents.length === 2 ? String(c.parents[1]) : undefined),
				() => {
					this.mergeSources.delete(sha)
					return undefined
				},
			)
			this.mergeSources.set(sha, source)
		}
		return source
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
