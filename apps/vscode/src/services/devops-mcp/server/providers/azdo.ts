/** Azure DevOps Services (dev.azure.com) Repos + Pipelines through the REST API (7.1). */

import { type PipelineSchema, parsePipelineInputs } from "../../pipelines/pipeline-inputs"
import { type Auth, adoAuth } from "../auth"
import { DevOpsError } from "../errors"
import { adoCollectionUrl, type Remote } from "../repo"
import {
	type Check,
	type ExpiredBuildPolicy,
	type FailedStep,
	type Fetch,
	Http,
	type JobResult,
	type MergeState,
	type NewPrComment,
	type PipelineDefinition,
	type PipelineDispatch,
	type PipelineRun,
	type PostedComment,
	type PrThread,
	type PullRequest,
	type Result,
	type ReviewVerdict,
	type RunReport,
	repoPath,
	type Status,
	type ToolProvider,
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

/** Thread states that close a discussion; `active` and `pending` leave it open. */
const THREAD_RESOLVED: Record<string, boolean> = {
	active: false,
	pending: false,
	fixed: true,
	wontFix: true,
	closed: true,
	byDesign: true,
}

/**
 * Reviewer votes. Azure DevOps has no "request changes": `request_changes` maps to "waiting for author" (-5),
 * which asks for changes without rejecting the pull request (-10). A `comment` verdict leaves the vote alone.
 */
const ADO_VOTES: Record<Exclude<ReviewVerdict, "comment">, { vote: number; label: string }> = {
	approve: { vote: 10, label: "Approved (10)" },
	request_changes: { vote: -5, label: "Waiting for author (-5)" },
}

/** `commentType: 1` is a text comment; `status: 1` an active thread. */
const TEXT_COMMENT = 1
const ACTIVE_THREAD = 1

export class AzureDevOpsProvider implements ToolProvider {
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
		auth: Auth = adoAuth(remote),
	) {
		// On-premises Azure DevOps Server: {collection URL}/{project}. Cloud: https://dev.azure.com/{org}/{project}.
		this.orgUrl = adoCollectionUrl(remote) ?? `https://dev.azure.com/${encodeURIComponent(remote.owner)}`
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
				templateParameters: Object.fromEntries(
					// Some Azure DevOps servers reject JSON arrays/objects here (HTTP 400, "runParameters"); they accept JSON text.
					Object.entries(inputs).map(([name, value]) => [
						name,
						value !== null && typeof value === "object" ? JSON.stringify(value) : value,
					]),
				),
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

	async cancelRun(runId: number): Promise<void> {
		await this.api("PATCH", `build/builds/${runId}`, {}, { status: "cancelling" })
	}

	private buildUrl(d: any, id: number): string {
		return d?._links?.web?.href ?? `${this.projectUrl}/_build/results?buildId=${id}`
	}

	async rerunRun(runId: number, failedOnly: boolean): Promise<PipelineDispatch> {
		if (failedOnly) {
			// "Rerun failed jobs": the same build retries its failed (and cancelled) jobs.
			const d = await this.api("PATCH", `build/builds/${runId}`, { retry: "true" }, {})
			return { runId, url: this.buildUrl(d, runId) }
		}
		const build = await this.api("GET", `build/builds/${runId}`)
		if (!build?.definition?.id) throw new DevOpsError(`Azure DevOps did not say which pipeline build ${runId} belongs to.`)
		const json: Record<string, unknown> = { definition: { id: build.definition.id }, sourceBranch: build.sourceBranch }
		// A pull request's merge ref is built again from the PR's current merge; any other branch reruns the same commit.
		if (build.sourceVersion && !String(build.sourceBranch ?? "").startsWith("refs/pull/")) {
			json.sourceVersion = build.sourceVersion
		}
		if (build.parameters) json.parameters = build.parameters
		if (build.templateParameters && Object.keys(build.templateParameters).length) {
			json.templateParameters = build.templateParameters
		}
		const d = await this.api("POST", "build/builds", {}, json)
		if (!Number.isSafeInteger(d?.id) || d.id <= 0) {
			throw new DevOpsError("Azure DevOps accepted the request but did not return a build ID.")
		}
		return { runId: d.id, url: this.buildUrl(d, d.id) }
	}

	private threadUrl(prId: number, threadId: number | string): string {
		return `${this.repoUrl}/pullrequest/${prId}?discussionId=${threadId}`
	}

	async listPrThreads(pr: PullRequest): Promise<PrThread[]> {
		const data = await this.api("GET", await this.prPath(`/${pr.id}/threads`))
		const threads: PrThread[] = []
		for (const t of data?.value ?? []) {
			if (t.isDeleted) continue
			// Votes, pushes and policy updates are system comments; they are not part of the discussion.
			const comments = (t.comments ?? []).filter((c: any) => !c.isDeleted && c.commentType !== "system" && c.content)
			if (!comments.length) continue
			const context = t.threadContext
			const path = context?.filePath ? repoPath(context.filePath) : undefined
			threads.push({
				kind: path ? "inline" : "general",
				replyId: String(t.id),
				path,
				line: path ? (context.rightFileStart?.line ?? context.leftFileStart?.line) : undefined,
				resolved: THREAD_RESOLVED[t.status],
				url: this.threadUrl(pr.id, t.id),
				comments: comments.map((c: any) => ({
					author: c.author?.displayName ?? "",
					body: c.content,
					created: c.publishedDate ?? c.lastUpdatedDate ?? "",
				})),
			})
		}
		return threads
	}

	async addPrComment(pr: PullRequest, request: NewPrComment): Promise<PostedComment> {
		const threads = await this.prPath(`/${pr.id}/threads`)
		if (request.replyTo !== undefined) {
			const id = Number(request.replyTo)
			if (!Number.isSafeInteger(id) || id <= 0) {
				throw new DevOpsError(`\`reply_to\` takes a thread id from pr_comments, not '${request.replyTo}'.`)
			}
			let thread: any
			try {
				thread = await this.api("GET", `${threads}/${id}`)
			} catch (error) {
				if (error instanceof DevOpsError && error.status === 404) {
					throw new DevOpsError(
						`PR #${pr.id} has no thread ${id}; \`reply_to\` takes a thread id from pr_comments.`,
						404,
					)
				}
				throw error
			}
			const root = (thread?.comments ?? []).find((c: any) => !c.isDeleted && c.commentType !== "system")
			await this.api(
				"POST",
				`${threads}/${id}/comments`,
				{},
				{ content: request.body, parentCommentId: root?.id ?? 1, commentType: TEXT_COMMENT },
			)
			return { kind: "reply", url: this.threadUrl(pr.id, id), replyId: String(id) }
		}
		const json: Record<string, unknown> = {
			comments: [{ parentCommentId: 0, content: request.body, commentType: TEXT_COMMENT }],
			status: ACTIVE_THREAD,
		}
		const inline = request.path !== undefined && request.line !== undefined
		if (inline) {
			const filePath = `/${repoPath(request.path as string)}`
			const iterations: any[] = (await this.api("GET", await this.prPath(`/${pr.id}/iterations`)))?.value ?? []
			const latest = Math.max(0, ...iterations.map((i) => Number(i.id) || 0))
			if (!latest) throw new DevOpsError(`PR #${pr.id} has no iterations yet, so there is no diff to comment on.`)
			// `$compareTo=0` compares the latest iteration with the target branch: every file the PR changes.
			const changes = await this.api("GET", await this.prPath(`/${pr.id}/iterations/${latest}/changes`), {
				$compareTo: 0,
				$top: 2000,
			})
			const change = (changes?.changeEntries ?? []).find((e: any) => e.item?.path === filePath)
			if (!change) {
				throw new DevOpsError(
					`${filePath.slice(1)} is not among the files PR #${pr.id} changes. Inline comments go on changed files: check the path (relative to the repository root), or post a general comment.`,
				)
			}
			json.threadContext = {
				filePath,
				rightFileStart: { line: request.line, offset: 1 },
				rightFileEnd: { line: request.line, offset: 1 },
			}
			json.pullRequestThreadContext = {
				changeTrackingId: change.changeTrackingId,
				iterationContext: { firstComparingIteration: 1, secondComparingIteration: latest },
			}
		}
		const t = await this.api("POST", threads, {}, json)
		return { kind: inline ? "inline comment" : "comment", url: this.threadUrl(pr.id, t?.id), replyId: String(t?.id) }
	}

	async reviewPr(pr: PullRequest, verdict: ReviewVerdict, body?: string): Promise<string> {
		const lines: string[] = []
		if (verdict !== "comment") {
			const { vote, label } = ADO_VOTES[verdict]
			const me = await this.me()
			await this.api("PUT", await this.prPath(`/${pr.id}/reviewers/${encodeURIComponent(me)}`), {}, { vote })
			lines.push(`Set your vote on PR #${pr.id} to ${label}: ${pr.url}`)
		}
		if (body?.trim()) {
			lines.push(`Posted the review comment: ${(await this.addPrComment(pr, { body })).url}`)
		}
		return lines.join("\n")
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

	async listExpiredBuildPolicies(pr: PullRequest): Promise<ExpiredBuildPolicy[]> {
		const repo = await this.repo()
		const artifactId = `vstfs:///CodeReview/CodeReviewId/${repo.project.id}/${pr.id}`
		const response = await this.api("GET", "policy/evaluations", { artifactId, "api-version": "7.1-preview.1" })
		return (response.value ?? [])
			.filter(
				(ev: any) =>
					ev.context?.isExpired === true &&
					Number.isSafeInteger(ev.context?.buildDefinitionId ?? ev.configuration?.settings?.buildDefinitionId),
			)
			.map((ev: any) => ({
				evaluationId: String(ev.evaluationId),
				name: ev.configuration?.settings?.displayName ?? ev.configuration?.type?.displayName ?? "Build validation",
				buildId: Number.isSafeInteger(ev.context?.buildId) ? ev.context.buildId : undefined,
			}))
			.filter((ev: ExpiredBuildPolicy) => /^[0-9a-f-]{36}$/i.test(ev.evaluationId))
	}

	async requeueBuildPolicy(evaluationId: string): Promise<void> {
		if (!/^[0-9a-f-]{36}$/i.test(evaluationId)) throw new DevOpsError("Invalid policy evaluation ID.")
		await this.api("PATCH", `policy/evaluations/${evaluationId}`, { "api-version": "7.1-preview.1" }, { status: "queued" })
	}
}
