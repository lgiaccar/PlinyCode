/** GitHub (github.com and GitHub Enterprise Server) through the REST API. */

import { type PipelineSchema, parsePipelineInputs } from "../../pipelines/pipeline-inputs"
import { type Auth, githubAuth } from "../auth"
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

/** `mergeable_state` values; only `dirty` means the branch conflicts with its base. */
const MERGE_STATES: Record<string, MergeState> = {
	dirty: "conflicts",
	clean: "clean",
	unstable: "clean",
	blocked: "clean",
	behind: "clean",
	has_hooks: "clean",
	draft: "clean",
	unknown: "pending",
}

/**
 * Only the single-PR endpoint reports mergeability, and `mergeable` is null
 * while GitHub is still computing it (it starts on the first request).
 */
function mergeState(d: any): MergeState | undefined {
	if (!("mergeable" in d)) {
		return undefined
	}
	if (d.mergeable === null) {
		return "pending"
	}
	return MERGE_STATES[d.mergeable_state] ?? (d.mergeable === false ? "conflicts" : "unknown")
}

const PR_LIST_PAGE = 100

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

export class GitHubProvider implements PipelineProvider {
	readonly kind = "GitHub"
	readonly maxBodyLength = 65536
	readonly repoUrl: string
	private readonly apiRoot: string
	private readonly api: string
	private readonly graphqlUrl: string
	private readonly http: Http
	private loginInfo?: Promise<string>

	constructor(
		private readonly remote: Remote,
		fetchImpl?: Fetch,
		auth: Auth = githubAuth(remote.host),
	) {
		this.apiRoot = remote.host === "github.com" ? "https://api.github.com" : `https://${remote.host}/api/v3`
		this.api = `${this.apiRoot}/repos/${remote.owner}/${remote.repo}`
		this.graphqlUrl = remote.host === "github.com" ? `${this.apiRoot}/graphql` : `https://${remote.host}/api/graphql`
		this.repoUrl = `https://${remote.host}/${remote.owner}/${remote.repo}`
		this.http = new Http(auth, { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, fetchImpl, {
			etags: true,
		})
	}

	get rateLimitRemaining(): number | undefined {
		return this.http.rateLimitRemaining
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
			// A merged or closed PR keeps `mergeable: null` for good; mergeability only matters while it is open.
			mergeState: d.state === "open" && !d.merged_at ? mergeState(d) : undefined,
			// A deleted fork leaves `head.repo` null.
			fork:
				d.head.repo === null ||
				(d.head.repo?.full_name !== undefined && d.head.repo.full_name !== d.base.repo?.full_name),
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
			pipeline: d.name || undefined,
			pipelineId: d.workflow_id,
		}
	}

	async defaultBranch(): Promise<string> {
		return (await this.get("")).default_branch
	}

	async listPipelines(): Promise<PipelineDefinition[]> {
		const pipelines: PipelineDefinition[] = []
		for (let page = 1; ; page++) {
			const workflows: any[] = (await this.get("/actions/workflows", { per_page: 100, page })).workflows ?? []
			pipelines.push(
				...workflows
					.filter((workflow) => workflow.state === "active")
					.map((workflow) => ({
						id: workflow.id,
						name: workflow.name,
						url: workflow.path
							? `${this.repoUrl}/actions/workflows/${encodeURIComponent(String(workflow.path).split("/").at(-1) ?? "")}`
							: `${this.repoUrl}/actions`,
					})),
			)
			if (workflows.length < 100) return pipelines
		}
	}

	async pipelineInputs(pipelineId: number, ref: string): Promise<PipelineSchema> {
		const workflow = await this.get(`/actions/workflows/${pipelineId}`)
		if (workflow.state !== "active") throw new DevOpsError("This workflow is not active.")
		const path = String(workflow.path).split("/").map(encodeURIComponent).join("/")
		const content = await this.get(`/contents/${path}`, { ref })
		if (typeof content.content !== "string" || content.encoding !== "base64") {
			throw new DevOpsError("GitHub did not return the workflow YAML.")
		}
		const schema = parsePipelineInputs(Buffer.from(content.content, "base64").toString("utf8"), "github", content.sha)
		const defaultRef = await this.defaultBranch()
		if (ref !== defaultRef && ref !== `refs/heads/${defaultRef}`) {
			const defaultContent = await this.get(`/contents/${path}`, { ref: defaultRef })
			const defaultSchema = parsePipelineInputs(
				Buffer.from(defaultContent.content ?? "", "base64").toString("utf8"),
				"github",
				defaultContent.sha,
			)
			if (defaultSchema.limitations.length)
				schema.limitations.push("Manual dispatch must also be enabled on the default branch.")
		}
		if (schema.inputs.some((input) => input.type === "environment")) {
			const environments: string[] = []
			for (let page = 1; ; page++) {
				const entries: any[] = (await this.get("/environments", { per_page: 100, page })).environments ?? []
				environments.push(...entries.map((entry) => String(entry.name)))
				if (entries.length < 100) break
			}
			for (const input of schema.inputs) {
				if (input.type === "environment") {
					input.type = "choice"
					input.options = environments
				}
			}
		}
		return schema
	}

	async queuePipeline(pipelineId: number, ref: string, inputs: Record<string, unknown>): Promise<PipelineDispatch> {
		const response = await this.http.json("POST", `${this.api}/actions/workflows/${pipelineId}/dispatches`, {
			json: { ref, inputs },
			apiVersion: this.remote.host === "github.com" ? "2026-03-10" : undefined,
		})
		return {
			runId:
				Number.isSafeInteger(response?.workflow_run_id) && response.workflow_run_id > 0
					? response.workflow_run_id
					: undefined,
			url: response?.html_url ?? `${this.repoUrl}/actions`,
		}
	}

	async getRun(runId: number): Promise<PipelineRun> {
		return this.run(await this.get(`/actions/runs/${runId}`))
	}

	async findOpenPr(branch: string): Promise<PullRequest | undefined> {
		const prs = await this.get<any[]>("/pulls", { head: `${this.remote.owner}:${branch}`, state: "open" })
		return prs.length ? this.pr(prs[0]) : undefined
	}

	async getPr(id: number): Promise<PullRequest> {
		return this.pr(await this.get(`/pulls/${id}`))
	}

	async listOpenPrs({ mine, limit }: { mine: boolean; limit: number }): Promise<PullRequest[]> {
		const prs = await this.get<any[]>("/pulls", {
			state: "open",
			sort: "updated",
			direction: "desc",
			per_page: mine ? PR_LIST_PAGE : Math.min(limit, PR_LIST_PAGE),
		})
		const login = mine ? await this.login() : undefined
		return prs
			.filter((d) => login === undefined || d.user?.login === login)
			.slice(0, limit)
			.map((d) => this.pr(d))
	}

	private login(): Promise<string> {
		if (!this.loginInfo) {
			this.loginInfo = this.http.json("GET", `${this.apiRoot}/user`).then((user) => String(user?.login ?? ""))
			this.loginInfo.catch(() => {
				this.loginInfo = undefined
			})
		}
		return this.loginInfo
	}

	async branchHead(branch: string): Promise<string | undefined> {
		const ref = branch.split("/").map(encodeURIComponent).join("/")
		try {
			return (await this.get(`/git/ref/heads/${ref}`))?.object?.sha
		} catch (error) {
			if (error instanceof DevOpsError && error.status === 404) return undefined
			throw error
		}
	}

	async createPr(title: string, body: string, source: string, target: string, draft: boolean): Promise<PullRequest> {
		const json = { title, body, head: source, base: target, draft }
		return this.pr(await this.http.json("POST", `${this.api}/pulls`, { json }))
	}

	async updatePr(id: number, title: string | undefined, body: string | undefined, draft?: boolean): Promise<PullRequest> {
		const json: Record<string, string> = {}
		if (title !== undefined) json.title = title
		if (body !== undefined) json.body = body
		let data = Object.keys(json).length
			? await this.http.json("PATCH", `${this.api}/pulls/${id}`, { json })
			: await this.get(`/pulls/${id}`)
		// The REST API ignores `draft` on update; only these GraphQL mutations change it.
		if (draft !== undefined && Boolean(data.draft) !== draft) {
			const mutation = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview"
			await this.graphql(`mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { clientMutationId } }`, {
				id: data.node_id,
			})
			data = { ...data, draft }
		}
		return this.pr(data)
	}

	/** GraphQL reports errors in a 200 response, so check the body as well as the status. */
	private async graphql(query: string, variables: Record<string, unknown>): Promise<any> {
		const response = await this.http.json("POST", this.graphqlUrl, { json: { query, variables } })
		const errors: any[] = response?.errors ?? []
		if (errors.length) {
			throw new DevOpsError(`GitHub GraphQL: ${errors.map((e) => e?.message ?? JSON.stringify(e)).join("; ")}`)
		}
		return response?.data
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
