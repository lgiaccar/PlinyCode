import { describe, expect, it } from "bun:test"
import { DevOpsError } from "../errors"
import { AzureDevOpsProvider } from "../providers/azdo"
import { GitHubProvider } from "../providers/github"
import { checkBody, type PullRequest } from "../providers/types"
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
