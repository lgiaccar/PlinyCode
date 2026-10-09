import { describe, expect, it } from "bun:test"
import { DevOpsError } from "../errors"
import { AzureDevOpsProvider } from "../providers/azdo"
import { GitHubProvider } from "../providers/github"
import { checkBody, type Fetch, Http, type PullRequest } from "../providers/types"
import { parseRemote, sameRepository } from "../repo"
import { FakeApi, staticAuth } from "./fake-api"

const GH = "/repos/octo/hello"

const ghPr = (overrides: Record<string, unknown> = {}) => ({
	number: 7,
	title: "Add feature",
	body: "Body",
	state: "open",
	merged_at: null,
	draft: true,
	head: { ref: "feature", sha: "abc123def" },
	base: { ref: "main" },
	user: { login: "octocat" },
	html_url: "https://github.com/octo/hello/pull/7",
	...overrides,
})

const github = (api: FakeApi) =>
	new GitHubProvider({ kind: "github", host: "github.com", owner: "octo", repo: "hello" }, api.fetch, staticAuth())

describe("GitHubProvider", () => {
	it("discovers dispatch inputs at the selected ref and queues typed values", async () => {
		const api = new FakeApi()
			.on("GET", `${GH}/actions/workflows`, {
				workflows: [{ id: 3, name: "Build", state: "active", html_url: "https://github.com/octo/hello/actions" }],
			})
			.on("GET", `${GH}/actions/workflows/3`, { path: ".github/workflows/build.yml", state: "active" })
			.on("GET", GH, { default_branch: "main" })
			.on("GET", `${GH}/contents/.github/workflows/build.yml`, {
				sha: "file-sha",
				encoding: "base64",
				content: Buffer.from(
					"on:\n  workflow_dispatch:\n    inputs:\n      enabled: {type: boolean, default: false}",
				).toString("base64"),
			})
			.on("POST", `${GH}/actions/workflows/3/dispatches`, {
				workflow_run_id: 42,
				html_url: "https://github.com/octo/hello/actions/runs/42",
			})
		const provider = github(api)
		expect(await provider.listPipelines()).toHaveLength(1)
		expect((await provider.pipelineInputs(3, "main")).inputs[0].default).toBe(false)
		expect(api.requests.find((request) => request.url.pathname.includes("/contents/"))?.url.searchParams.get("ref")).toBe(
			"main",
		)
		expect((await provider.queuePipeline(3, "main", { enabled: false })).runId).toBe(42)
		expect(api.lastJson("POST")).toEqual({ ref: "main", inputs: { enabled: false } })
		expect(api.last("POST").headers["X-GitHub-Api-Version"]).toBe("2026-03-10")
	})

	it("keeps accepted legacy dispatches unidentified instead of guessing a run", async () => {
		const api = new FakeApi().on("POST", `${GH}/actions/workflows/3/dispatches`, null)
		expect((await github(api).queuePipeline(3, "main", {})).runId).toBeUndefined()
		expect(api.requests).toHaveLength(1)
	})

	it("creates a PR with the given payload and auth", async () => {
		const api = new FakeApi().on("POST", `${GH}/pulls`, ghPr())
		const pr = await github(api).createPr("Add feature", "## Summary", "feature", "main", true)
		expect(api.lastJson("POST")).toEqual({
			title: "Add feature",
			body: "## Summary",
			head: "feature",
			base: "main",
			draft: true,
		})
		expect(api.last("POST").headers.Authorization).toBe("Bearer test-token")
		expect([pr.id, pr.draft, pr.sourceBranch, pr.state]).toEqual([7, true, "feature", "open"])
	})

	it("reports merged PRs and sends only the fields being updated", async () => {
		const api = new FakeApi().on(
			"PATCH",
			`${GH}/pulls/7`,
			ghPr({ body: "new", state: "closed", merged_at: "2026-09-01T00:00:00Z" }),
		)
		const pr = await github(api).updatePr(7, undefined, "new")
		expect(api.lastJson("PATCH")).toEqual({ body: "new" })
		expect(pr.state).toBe("merged")
	})

	it("publishes a draft through the GraphQL mutation, which the REST API does not offer", async () => {
		const api = new FakeApi()
			.on("GET", `${GH}/pulls/7`, ghPr({ node_id: "PR_node7" }))
			.on("POST", "/graphql", { data: { markPullRequestReadyForReview: { clientMutationId: null } } })
		const pr = await github(api).updatePr(7, undefined, undefined, false)
		const request = api.lastJson("POST") as { query: string; variables: unknown }
		expect(api.last("POST").url.href).toBe("https://api.github.com/graphql")
		expect(request.query).toContain("markPullRequestReadyForReview")
		expect(request.variables).toEqual({ id: "PR_node7" })
		expect(api.requests.filter((r) => r.method === "PATCH")).toHaveLength(0)
		expect(pr.draft).toBe(false)
	})

	it("converts a PR back to a draft only when it is not one already", async () => {
		const api = new FakeApi()
			.on("PATCH", `${GH}/pulls/7`, ghPr({ draft: false, node_id: "PR_node7" }))
			.on("POST", "/graphql", { data: {} })
		expect((await github(api).updatePr(7, "New title", undefined, true)).draft).toBe(true)
		expect((api.lastJson("POST") as { query: string }).query).toContain("convertPullRequestToDraft")

		const unchanged = new FakeApi().on("GET", `${GH}/pulls/7`, ghPr())
		expect((await github(unchanged).updatePr(7, undefined, undefined, true)).draft).toBe(true)
		expect(unchanged.requests.filter((r) => r.method === "POST")).toHaveLength(0)
	})

	it("reports GraphQL errors returned with a 200 status", async () => {
		const api = new FakeApi()
			.on("GET", `${GH}/pulls/7`, ghPr({ node_id: "PR_node7" }))
			.on("POST", "/graphql", { errors: [{ message: "Resource not accessible by integration" }] })
		await expect(github(api).updatePr(7, undefined, undefined, false)).rejects.toThrow(
			"GitHub GraphQL: Resource not accessible by integration",
		)
	})

	it("passes API error details to the model", async () => {
		const api = new FakeApi().on(
			"POST",
			`${GH}/pulls`,
			{ message: "Validation Failed", errors: [{ message: "A pull request already exists" }] },
			422,
		)
		await expect(github(api).createPr("t", "b", "feature", "main", false)).rejects.toThrow(
			"HTTP 422: Validation Failed (A pull request already exists)",
		)
	})

	it("lists a PR's runs by head SHA", async () => {
		const api = new FakeApi().on("GET", `${GH}/actions/runs`, {
			workflow_runs: [
				{
					id: 1,
					name: "ci",
					status: "completed",
					conclusion: "timed_out",
					head_branch: "feature",
					head_sha: "abc123def",
					html_url: "u",
					run_started_at: "2026-09-01T10:00:00Z",
					updated_at: "2026-09-01T10:02:05Z",
				},
			],
		})
		const runs = await github(api).listRuns("ignored", { headSha: "abc123def" } as PullRequest, 5)
		const params = api.last("GET").url.searchParams
		expect(params.get("head_sha")).toBe("abc123def")
		expect(params.has("branch")).toBe(false)
		expect([runs[0].status, runs[0].result]).toEqual(["completed", "failure"])
	})

	it("reports failed steps with annotations and the log excerpt", async () => {
		const api = new FakeApi()
			.on("GET", `${GH}/actions/runs/9`, {
				id: 9,
				name: "ci",
				status: "completed",
				conclusion: "failure",
				head_branch: "feature",
				head_sha: "abc",
				html_url: "u",
			})
			.on("GET", `${GH}/actions/runs/9/jobs`, {
				jobs: [
					{ id: 100, name: "lint", status: "completed", conclusion: "success", steps: [] },
					{
						id: 101,
						name: "test",
						status: "completed",
						conclusion: "failure",
						steps: [
							{ name: "checkout", conclusion: "success" },
							{ name: "pytest", conclusion: "failure" },
						],
					},
				],
			})
			.on("GET", `${GH}/check-runs/101/annotations`, [
				{ annotation_level: "failure", message: "test_x failed" },
				{ annotation_level: "warning", message: "deprecated" },
			])
			.onText(
				"GET",
				`${GH}/actions/jobs/101/logs`,
				"2026-09-01T10:00:00.1234567Z FAILED test_x\n2026-09-01T10:00:01.0Z ##[error]exit 1\ncleanup",
			)
		const report = await github(api).runReport(9, 5)
		expect(report.jobs.map((j) => j.result)).toEqual(["success", "failure"])
		expect(report.failures).toEqual([
			{ job: "test", step: "pytest", errors: ["test_x failed"], logTail: "FAILED test_x\n##[error]exit 1" },
		])
	})

	it("limits descriptions to 65536 characters", () => {
		const provider = github(new FakeApi())
		checkBody(provider, "x".repeat(65536))
		expect(() => checkBody(provider, "x".repeat(65537))).toThrow(/at most 65536/)
	})
})

const PROJ = "/acme/My Project/_apis"
const PRS = `${PROJ}/git/repositories/r-1/pullrequests`

const adoPr = {
	pullRequestId: 42,
	title: "Add feature",
	description: "Body",
	status: "active",
	isDraft: true,
	sourceRefName: "refs/heads/feature",
	targetRefName: "refs/heads/main",
	createdBy: { displayName: "Jane Doe" },
	lastMergeSourceCommit: { commitId: "abc" },
}

const azdo = (api: FakeApi, auth = staticAuth()) => {
	api.on("GET", `${PROJ}/git/repositories/web-app`, {
		id: "r-1",
		defaultBranch: "refs/heads/main",
		project: { id: "p-1" },
	})
	return new AzureDevOpsProvider(
		{ kind: "ado", host: "dev.azure.com", owner: "acme", repo: "web-app", project: "My Project" },
		api.fetch,
		auth,
	)
}

describe("AzureDevOpsProvider", () => {
	it("discovers repository YAML parameters and sends templateParameters with the selected ref", async () => {
		const definition = {
			id: 4,
			name: "Deploy",
			process: { type: 2, yamlFilename: "/pipelines/deploy.yml" },
			repository: { id: "r-1" },
			queueStatus: "enabled",
		}
		const api = new FakeApi()
			.on("GET", `${PROJ}/build/definitions`, {
				value: [definition, { id: 5, process: { type: 1 }, queueStatus: "enabled" }],
			})
			.on("GET", `${PROJ}/build/definitions/4`, definition)
			.on("GET", `${PROJ}/git/repositories/r-1/items`, {
				commitId: "sha",
				content:
					"parameters:\n  - name: enabled\n    type: boolean\n    default: false\n  - name: count\n    type: number\n    default: 0",
			})
			.on("POST", `${PROJ}/pipelines/4/runs`, { id: 55 })
		const provider = azdo(api)
		expect((await provider.listPipelines()).map((definition) => definition.id)).toEqual([4])
		expect((await provider.pipelineInputs(4, "refs/tags/v1")).inputs.map((input) => input.default)).toEqual([false, 0])
		expect(api.last("GET").url.searchParams.get("versionDescriptor.versionType")).toBe("tag")
		expect(api.last("GET").url.searchParams.get("versionDescriptor.version")).toBe("v1")
		expect((await provider.queuePipeline(4, "refs/tags/v1", { enabled: false, count: 0 })).runId).toBe(55)
		expect(api.lastJson("POST")).toEqual({
			templateParameters: { enabled: false, count: 0 },
			resources: { repositories: { self: { refName: "refs/tags/v1" } } },
		})
	})

	it("rejects parameter discovery for a pipeline from another repository", async () => {
		const api = new FakeApi().on("GET", `${PROJ}/build/definitions/4`, { process: { type: 2 }, repository: { id: "other" } })
		await expect(azdo(api).pipelineInputs(4, "main")).rejects.toThrow("connected to this workspace")
		expect(api.requests.some((request) => request.url.pathname.endsWith("/items"))).toBe(false)
	})

	it("creates a PR with full refs", async () => {
		const api = new FakeApi().on("POST", PRS, adoPr)
		const pr = await azdo(api).createPr("Add feature", "## Summary", "feature", "main", true)
		expect(api.lastJson("POST")).toEqual({
			sourceRefName: "refs/heads/feature",
			targetRefName: "refs/heads/main",
			title: "Add feature",
			description: "## Summary",
			isDraft: true,
		})
		expect(api.last("POST").url.searchParams.get("api-version")).toBe("7.1")
		expect([pr.id, pr.state, pr.sourceBranch]).toEqual([42, "open", "feature"])
		expect(pr.url).toBe("https://dev.azure.com/acme/My%20Project/_git/web-app/pullrequest/42")
	})

	it("finds the default branch and the open PR for a branch", async () => {
		const api = new FakeApi().on("GET", PRS, { value: [adoPr] })
		const provider = azdo(api)
		expect(await provider.defaultBranch()).toBe("main")
		const pr = await provider.findOpenPr("feature")
		const params = api.last("GET").url.searchParams
		expect(params.get("searchCriteria.sourceRefName")).toBe("refs/heads/feature")
		expect(params.get("searchCriteria.status")).toBe("active")
		expect(pr?.id).toBe(42)
	})

	it("targets the on-premises server's own host and full collection path, not dev.azure.com or the git SSH port", async () => {
		// Parse an on-premises remote end-to-end, rather than hand-building a Remote, so this catches both
		// the dropped "tfs" app-path segment and the port-22 carrying over from the ssh:// git URL into the
		// HTTPS REST API base.
		const remote = parseRemote("ssh://tfs.internal.example.com:22/tfs/Some_Collection/Meshing/_git/SomeRepo")
		const api = new FakeApi().on("GET", "/tfs/Some_Collection/Meshing/_apis/git/repositories/SomeRepo", {
			id: "r-1",
			defaultBranch: "refs/heads/main",
			project: { id: "p-1" },
		})
		const provider = new AzureDevOpsProvider(remote, api.fetch, staticAuth())
		expect(await provider.defaultBranch()).toBe("main")
		expect(api.last("GET").url.href).toContain("https://tfs.internal.example.com/tfs/Some_Collection/Meshing/_apis/")
	})

	it("publishes a draft by patching isDraft", async () => {
		const api = new FakeApi().on("PATCH", `${PRS}/42`, { ...adoPr, isDraft: false })
		const pr = await azdo(api).updatePr(42, undefined, undefined, false)
		expect(api.lastJson("PATCH")).toEqual({ isDraft: false })
		expect(pr.draft).toBe(false)
	})

	it("limits descriptions to 4000 characters", () => {
		const provider = azdo(new FakeApi())
		checkBody(provider, "x".repeat(4000))
		expect(() => checkBody(provider, "x".repeat(4001))).toThrow(/Azure DevOps allows at most 4000/)
	})

	it("lists a PR's builds through its merge ref", async () => {
		const api = new FakeApi().on("GET", `${PROJ}/build/builds`, {
			value: [
				{
					id: 7,
					buildNumber: "20260901.1",
					definition: { name: "CI" },
					status: "completed",
					result: "partiallySucceeded",
					sourceBranch: "refs/pull/42/merge",
				},
				{ id: 8, buildNumber: "20260901.2", definition: { name: "CI" }, status: "inProgress", result: "none" },
			],
		})
		const runs = await azdo(api).listRuns(undefined, { id: 42 } as PullRequest, 5)
		const params = api.last("GET").url.searchParams
		expect(params.get("branchName")).toBe("refs/pull/42/merge")
		expect(params.get("$top")).toBe("5")
		expect(params.get("repositoryId")).toBe("r-1")
		expect(runs.map((r) => [r.name, r.status, r.result])).toEqual([
			["CI #20260901.1", "completed", "partial"],
			["CI #20260901.2", "in_progress", undefined],
		])
	})

	it("walks the timeline to the job and fetches the failed task's log", async () => {
		const api = new FakeApi()
			.on("GET", `${PROJ}/build/builds/7`, {
				id: 7,
				buildNumber: "1",
				definition: { name: "CI" },
				status: "completed",
				result: "failed",
				sourceBranch: "refs/heads/feature",
			})
			.on("GET", `${PROJ}/build/builds/7/timeline`, {
				records: [
					{ id: "s", parentId: null, type: "Stage", name: "Build", state: "completed", result: "failed", order: 1 },
					{ id: "j", parentId: "s", type: "Job", name: "Linux", state: "completed", result: "failed", order: 1 },
					{ id: "t1", parentId: "j", type: "Task", name: "Restore", state: "completed", result: "succeeded", order: 1 },
					{
						id: "t2",
						parentId: "j",
						type: "Task",
						name: "Run tests",
						state: "completed",
						result: "failed",
						order: 2,
						log: { id: 12 },
						issues: [
							{ type: "error", message: "3 tests failed" },
							{ type: "warning", message: "slow" },
						],
					},
				],
			})
			.onText("GET", `${PROJ}/build/builds/7/logs/12`, "line1\nline2\nline3")
		const report = await azdo(api).runReport(7, 2)
		expect(report.jobs.map((j) => [j.name, j.result])).toEqual([["Linux", "failure"]])
		expect(report.failures).toEqual([
			{ job: "Linux", step: "Run tests", errors: ["3 tests failed"], logTail: "line2\nline3" },
		])
		expect(api.last("GET").headers.Accept).toBe("text/plain")
	})

	it("merges branch policies with the newest status per context", async () => {
		const api = new FakeApi()
			.on("GET", `${PROJ}/policy/evaluations`, {
				value: [
					{
						status: "rejected",
						context: { buildId: 7 },
						configuration: {
							isBlocking: true,
							type: { displayName: "Build" },
							settings: { displayName: "CI build" },
						},
					},
					{
						status: "approved",
						configuration: { isBlocking: false, type: { displayName: "Minimum number of reviewers" } },
					},
				],
			})
			.on("GET", `${PRS}/42/statuses`, {
				value: [
					{ id: 1, state: "pending", context: { genre: "sonar", name: "quality" } },
					{ id: 2, state: "succeeded", context: { genre: "sonar", name: "quality" }, targetUrl: "https://sonar" },
				],
			})
		const checks = await azdo(api).prChecks({ id: 42 } as PullRequest)
		expect(api.requests.find((r) => r.url.pathname.endsWith("/evaluations"))?.url.searchParams.get("artifactId")).toBe(
			"vstfs:///CodeReview/CodeReviewId/p-1/42",
		)
		expect(checks.map((c) => [c.name, c.result, c.required])).toEqual([
			["CI build", "failure", true],
			["Minimum number of reviewers", "success", false],
			["sonar/quality", "success", undefined],
		])
		expect(checks[0].url).toEndWith("buildId=7")
	})

	it("reports an HTML sign-in page as rejected credentials", async () => {
		const api = new FakeApi()
		const provider = azdo(api)
		api.onText("GET", `${PROJ}/git/repositories/web-app`, "<html>Sign in</html>", "text/html", 203)
		await expect(provider.defaultBranch()).rejects.toThrow(DevOpsError)
		await expect(provider.defaultBranch()).rejects.toThrow(/sign-in page/)
	})

	it("retries once with a fresh credential after a 401", async () => {
		let calls = 0
		let invalidated = 0
		const auth = {
			header: async () => `Bearer token-${++calls}`,
			invalidate: () => {
				invalidated++
			},
		}
		const api = new FakeApi()
		const provider = azdo(api, auth)
		api.on("GET", `${PROJ}/git/repositories/web-app`, { message: "expired" }, 401)
		await expect(provider.defaultBranch()).rejects.toThrow(/HTTP 401/)
		expect(invalidated).toBe(1)
		expect(api.requests.map((r) => r.headers.Authorization)).toEqual(["Bearer token-1", "Bearer token-2"])
	})
})

describe("CI board queries", () => {
	it("GitHub: maps mergeability, and reports it as pending while GitHub computes it", async () => {
		const api = new FakeApi().on("GET", `${GH}/pulls/7`, ghPr({ mergeable: false, mergeable_state: "dirty" }))
		expect((await github(api).getPr(7)).mergeState).toBe("conflicts")
		api.on("GET", `${GH}/pulls/7`, ghPr({ mergeable: null, mergeable_state: "unknown" }))
		expect((await github(api).getPr(7)).mergeState).toBe("pending")
		api.on("GET", `${GH}/pulls/7`, ghPr({ mergeable: true, mergeable_state: "blocked" }))
		expect((await github(api).getPr(7)).mergeState).toBe("clean")
		// GitHub never computes mergeability for a merged PR; it is not "pending" for ever.
		api.on("GET", `${GH}/pulls/7`, ghPr({ state: "closed", merged_at: "2026-10-01T00:00:00Z", mergeable: null }))
		expect((await github(api).getPr(7)).mergeState).toBeUndefined()
		// The list endpoint carries no mergeability at all.
		expect((github(new FakeApi()) as any).pr(ghPr()).mergeState).toBeUndefined()
	})

	it("GitHub: flags PRs from forks", async () => {
		const own = { repo: { full_name: "octo/hello" } }
		const api = new FakeApi().on("GET", `${GH}/pulls`, [
			ghPr({ number: 1, head: { ref: "a", sha: "1", repo: { full_name: "octo/hello" } }, base: { ref: "main", ...own } }),
			ghPr({
				number: 2,
				head: { ref: "b", sha: "2", repo: { full_name: "someone/hello" } },
				base: { ref: "main", ...own },
			}),
			ghPr({ number: 3, head: { ref: "c", sha: "3", repo: null }, base: { ref: "main", ...own } }),
		])
		const prs = await github(api).listOpenPrs({ mine: false, limit: 10 })
		expect(prs.map((p) => [p.id, p.fork])).toEqual([
			[1, false],
			[2, true],
			[3, true],
		])
	})

	it("GitHub: lists open PRs, newest first, and keeps the signed-in user's for `mine`", async () => {
		const api = new FakeApi()
			.on("GET", `${GH}/pulls`, [
				ghPr({ number: 1, user: { login: "me" } }),
				ghPr({ number: 2, user: { login: "other" } }),
				ghPr({ number: 3, user: { login: "me" } }),
			])
			.on("GET", "/user", { login: "me" })
		const provider = github(api)
		expect((await provider.listOpenPrs({ mine: true, limit: 10 })).map((p) => p.id)).toEqual([1, 3])
		expect((await provider.listOpenPrs({ mine: false, limit: 2 })).map((p) => p.id)).toEqual([1, 2])
		const params = api.requests.find((r) => r.url.pathname === `${GH}/pulls`)?.url.searchParams
		expect([params?.get("state"), params?.get("sort"), params?.get("direction")]).toEqual(["open", "updated", "desc"])
		// The login is asked once.
		expect(api.requests.filter((r) => r.url.pathname === "/user")).toHaveLength(1)
	})

	it("GitHub: reads a branch head from the server, and undefined for a branch it does not have", async () => {
		const api = new FakeApi()
			.on("GET", `${GH}/git/ref/heads/user/feature`, { object: { sha: "f00" } })
			.on("GET", `${GH}/git/ref/heads/gone`, { message: "Not Found" }, 404)
		expect(await github(api).branchHead("user/feature")).toBe("f00")
		expect(await github(api).branchHead("gone")).toBeUndefined()
	})

	it("GitHub: names a run's workflow so runs of one workflow group together", async () => {
		const api = new FakeApi().on("GET", `${GH}/actions/runs`, {
			workflow_runs: [{ id: 1, name: "ci", workflow_id: 55, status: "queued", head_sha: "a", html_url: "u" }],
		})
		const [run] = await github(api).listRuns("feature", undefined, 5)
		expect([run.pipeline, run.pipelineId]).toEqual(["ci", 55])
	})

	it("GitHub: revalidates a repeated GET with its ETag and reuses the cached body on 304", async () => {
		const api = new FakeApi().onTagged("GET", `${GH}/pulls/7`, ghPr({ title: "cached" }), '"v1"')
		const provider = github(api)
		expect((await provider.getPr(7)).title).toBe("cached")
		expect((await provider.getPr(7)).title).toBe("cached")
		expect(api.requests.map((r): string | undefined => r.headers["If-None-Match"])).toEqual([undefined, '"v1"'])
		expect(provider.rateLimitRemaining).toBe(4999)
	})

	it("Azure DevOps: maps merge status and forks", async () => {
		const api = new FakeApi().on("GET", PRS, {
			value: [
				{ ...adoPr, pullRequestId: 1, mergeStatus: "conflicts" },
				{ ...adoPr, pullRequestId: 2, mergeStatus: "succeeded", forkSource: { name: "refs/heads/x" } },
				{ ...adoPr, pullRequestId: 3, mergeStatus: "queued" },
				{ ...adoPr, pullRequestId: 4 },
			],
		})
		const prs = await azdo(api).listOpenPrs({ mine: false, limit: 10 })
		expect(prs.map((p) => [p.id, p.mergeState, p.fork])).toEqual([
			[1, "conflicts", false],
			[2, "clean", true],
			[3, "pending", false],
			[4, undefined, false],
		])
		const params = api.last("GET").url.searchParams
		expect([params.get("searchCriteria.status"), params.get("$top"), params.has("searchCriteria.creatorId")]).toEqual([
			"active",
			"10",
			false,
		])
	})

	it("Azure DevOps: filters `mine` by the signed-in user's id from connection data", async () => {
		const api = new FakeApi()
			.on("GET", PRS, { value: [adoPr] })
			.on("GET", "/acme/_apis/connectionData", { authenticatedUser: { id: "user-1" } })
		await azdo(api).listOpenPrs({ mine: true, limit: 5 })
		expect(api.last("GET").url.searchParams.get("searchCriteria.creatorId")).toBe("user-1")
	})

	it("Azure DevOps: reads a branch head from the exact ref, not a prefix match", async () => {
		const api = new FakeApi().on("GET", `${PROJ}/git/repositories/r-1/refs`, {
			value: [
				{ name: "refs/heads/feature-2", objectId: "222" },
				{ name: "refs/heads/feature", objectId: "111" },
			],
		})
		const provider = azdo(api)
		expect(await provider.branchHead("feature")).toBe("111")
		expect(api.last("GET").url.searchParams.get("filter")).toBe("heads/feature")
		expect(await provider.branchHead("feat")).toBeUndefined()
	})

	it("Azure DevOps: names a run's definition so builds of one pipeline group together", async () => {
		const api = new FakeApi().on("GET", `${PROJ}/build/builds`, {
			value: [
				{ id: 9, buildNumber: "20261007.3", definition: { name: "GPUSurfer-win_cpu", id: 16659 }, status: "inProgress" },
			],
		})
		const [run] = await azdo(api).listRuns("feature", undefined, 5)
		expect([run.name, run.pipeline, run.pipelineId]).toEqual(["GPUSurfer-win_cpu #20261007.3", "GPUSurfer-win_cpu", 16659])
	})

	it("Azure DevOps Server: finds a PR build's source commit from the merge commit it built", async () => {
		// On-premises servers leave `pr.sourceSha` out of the trigger info (as ado.internal.synopsys.com does).
		const prBuild = (id: number, name: string) => ({
			id,
			definition: { name },
			status: "completed",
			result: "failed",
			sourceBranch: "refs/pull/42/merge",
			sourceVersion: "merge1",
			triggerInfo: { "pr.number": "42", "pr.isFork": "False" },
		})
		const api = new FakeApi()
			.on("GET", `${PROJ}/build/builds`, { value: [prBuild(1, "win_cpu"), prBuild(2, "win_cuda")] })
			.on("GET", `${PROJ}/git/repositories/r-1/commits/merge1`, { parents: ["stage-head", "pr-head"] })
		const provider = azdo(api)
		const runs = await provider.listRuns(undefined, { id: 42, headSha: "pr-head" } as PullRequest, 10)
		expect(runs.map((r) => [r.commit, r.headCommit])).toEqual([
			["merge1", "pr-head"],
			["merge1", "pr-head"],
		])
		await provider.listRuns(undefined, { id: 42, headSha: "pr-head" } as PullRequest, 10)
		// One lookup per merge commit, ever.
		expect(api.requests.filter((r) => r.url.pathname.endsWith("/commits/merge1"))).toHaveLength(1)
	})
})

describe("Http redirects", () => {
	/** A server whose old host redirects to its new one, and a log URL that redirects to signed storage. */
	function hosts() {
		const seen: { url: string; auth?: string }[] = []
		const fetch: Fetch = async (input, init) => {
			const url = new URL(String(input))
			const auth = (init?.headers as Record<string, string>).Authorization
			seen.push({ url: url.href, auth })
			if (url.host === "tfs.old.example.com") {
				return new Response(null, {
					status: 302,
					headers: { location: url.href.replace(url.host, "ado.new.example.com") },
				})
			}
			if (url.pathname.endsWith("/logs/7")) {
				return new Response(null, { status: 302, headers: { location: "https://blob.example.net/log?sig=abc" } })
			}
			if (url.host === "ado.new.example.com" && !auth) {
				return new Response(JSON.stringify({ message: "TF400813: anonymous" }), { status: 401 })
			}
			return new Response(JSON.stringify({ ok: true, host: url.host }), { headers: { "content-type": "application/json" } })
		}
		return { seen, http: new Http(staticAuth("Basic pat"), { Accept: "application/json" }, fetch) }
	}

	it("keeps the credentials when a renamed server redirects to its new host, and goes there directly next time", async () => {
		const { seen, http } = hosts()
		expect(
			await http.json<{ ok: boolean; host: string }>("GET", "https://tfs.old.example.com/tfs/C/P/_apis/git/repositories/R"),
		).toEqual({
			ok: true,
			host: "ado.new.example.com",
		})
		await http.json("GET", "https://tfs.old.example.com/tfs/C/P/_apis/build/builds")
		expect(seen.map((s): [string, string | undefined] => [new URL(s.url).host, s.auth])).toEqual([
			["tfs.old.example.com", "Basic pat"],
			["ado.new.example.com", "Basic pat"],
			["ado.new.example.com", "Basic pat"],
		])
	})

	it("does not send the credentials along a redirect to anywhere else", async () => {
		const { seen, http } = hosts()
		await http.request("GET", "https://ado.new.example.com/tfs/C/P/_apis/build/builds/1/logs/7", { accept: "text/plain" })
		expect(seen.map((s): [string, string | undefined] => [new URL(s.url).host, s.auth])).toEqual([
			["ado.new.example.com", "Basic pat"],
			["blob.example.net", undefined],
		])
	})
})

describe("sameRepository", () => {
	it("matches an Azure DevOps Server repository across its host names, and nothing else", () => {
		const clone = parseRemote("ssh://tfs.ansys.com:22/tfs/ANSYS_Development/Meshing/_git/GPUSurfer")
		const link = parseRemote("https://ado.internal.synopsys.com/tfs/ANSYS_Development/Meshing/_git/gpusurfer", "ado")
		expect(sameRepository(clone, link)).toBe(true)
		expect(
			sameRepository(clone, parseRemote("https://ado.internal.synopsys.com/tfs/ANSYS_Development/Meshing/_git/Other")),
		).toBe(false)
		const gh = parseRemote("git@github.com:Octo/Hello.git")
		expect(sameRepository(gh, parseRemote("https://github.com/octo/hello"))).toBe(true)
		expect(sameRepository(gh, parseRemote("https://git.example.com/octo/hello", "github"))).toBe(false)
	})
})
