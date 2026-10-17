/** Recorded-fixture tests of the PR review and pipeline control calls, on GitHub and Azure DevOps (Services and Server). */
import { describe, expect, it } from "bun:test"
import { AzureDevOpsProvider } from "../providers/azdo"
import { GitHubProvider } from "../providers/github"
import type { PullRequest } from "../providers/types"
import { parseRemote } from "../repo"
import { FakeApi, staticAuth } from "./fake-api"

const GH = "/repos/octo/hello"

const github = (api: FakeApi) =>
	new GitHubProvider({ kind: "github", host: "github.com", owner: "octo", repo: "hello" }, api.fetch, staticAuth())

const ghPr: PullRequest = {
	id: 7,
	title: "Add feature",
	body: "",
	state: "open",
	draft: false,
	sourceBranch: "feature",
	targetBranch: "main",
	author: "octocat",
	url: "https://github.com/octo/hello/pull/7",
	headSha: "abc123def",
}

const user = (login: string) => ({ login })

describe("GitHub review calls", () => {
	it("lists general comments, inline threads with their resolved state, and review verdicts", async () => {
		const api = new FakeApi()
			.on("GET", `${GH}/issues/7/comments`, [
				{ id: 1, user: user("bob"), body: "LGTM", created_at: "2026-10-01T10:00:00Z", html_url: "https://gh/c1" },
			])
			.on("GET", `${GH}/pulls/7/comments`, [
				{
					id: 102,
					in_reply_to_id: 101,
					path: "src/a.ts",
					line: 12,
					user: user("octocat"),
					body: "Done.",
					created_at: "2026-10-03T10:00:00Z",
				},
				{
					id: 101,
					path: "src/a.ts",
					line: 12,
					user: user("jane"),
					body: "Rename this.",
					created_at: "2026-10-02T10:00:00Z",
					html_url: "https://gh/r101",
				},
				{
					id: 201,
					path: "src/b.ts",
					line: null,
					original_line: 4,
					user: user("jane"),
					body: "Outdated",
					created_at: "2026-09-30T10:00:00Z",
				},
			])
			.on("GET", `${GH}/pulls/7/reviews`, [
				{
					id: 9,
					user: user("jane"),
					state: "CHANGES_REQUESTED",
					body: "Needs tests.",
					submitted_at: "2026-10-02T11:00:00Z",
				},
				{ id: 10, user: user("jane"), state: "COMMENTED", body: "", submitted_at: "2026-10-02T10:00:00Z" },
				{ id: 11, user: user("me"), state: "PENDING", body: "draft" },
			])
			.on("POST", "/graphql", {
				data: {
					repository: {
						pullRequest: {
							reviewThreads: {
								nodes: [
									{ isResolved: true, comments: { nodes: [{ databaseId: 101 }] } },
									{ isResolved: false, comments: { nodes: [{ databaseId: 201 }] } },
								],
							},
						},
					},
				},
			})
		const threads = await github(api).listPrThreads(ghPr)
		expect(threads).toEqual([
			{
				kind: "general",
				url: "https://gh/c1",
				comments: [{ author: "bob", body: "LGTM", created: "2026-10-01T10:00:00Z" }],
			},
			// Inline threads come in the order they started.
			{
				kind: "inline",
				replyId: "201",
				path: "src/b.ts",
				line: 4,
				resolved: false,
				url: undefined,
				comments: [{ author: "jane", body: "Outdated", created: "2026-09-30T10:00:00Z" }],
			},
			{
				kind: "inline",
				replyId: "101",
				path: "src/a.ts",
				line: 12,
				resolved: true,
				url: "https://gh/r101",
				comments: [
					{ author: "jane", body: "Rename this.", created: "2026-10-02T10:00:00Z" },
					{ author: "octocat", body: "Done.", created: "2026-10-03T10:00:00Z" },
				],
			},
			{
				kind: "review",
				verdict: "changes requested",
				url: undefined,
				comments: [{ author: "jane", body: "Needs tests.", created: "2026-10-02T11:00:00Z" }],
			},
		])
		const listed = api.requests.find((r) => r.url.pathname === `${GH}/issues/7/comments`)
		expect(listed?.url.searchParams.get("per_page")).toBe("100")
		expect((api.lastJson("POST") as { variables: unknown }).variables).toEqual({ owner: "octo", repo: "hello", number: 7 })
	})

	it("still lists threads, without a resolved state, when GraphQL is not available", async () => {
		const api = new FakeApi()
			.on("GET", `${GH}/issues/7/comments`, [])
			.on("GET", `${GH}/pulls/7/comments`, [
				{ id: 101, path: "a.ts", line: 1, user: user("jane"), body: "x", created_at: "2026-10-02T10:00:00Z" },
			])
			.on("GET", `${GH}/pulls/7/reviews`, [])
			.on("POST", "/graphql", { message: "Not found" }, 404)
		const [thread] = await github(api).listPrThreads(ghPr)
		expect(thread.resolved).toBeUndefined()
		expect(thread.replyId).toBe("101")
	})

	it("posts a general comment, an inline comment on the head commit, and a reply", async () => {
		const api = new FakeApi()
			.on("POST", `${GH}/issues/7/comments`, { id: 5, html_url: "https://gh/c5" }, 201)
			.on("POST", `${GH}/pulls/7/comments`, { id: 301, html_url: "https://gh/r301" }, 201)
			.on("POST", `${GH}/pulls/7/comments/101/replies`, { id: 302, html_url: "https://gh/r302" }, 201)
		const provider = github(api)

		expect(await provider.addPrComment(ghPr, { body: "Hi" })).toEqual({ kind: "comment", url: "https://gh/c5" })
		expect(api.lastJson("POST")).toEqual({ body: "Hi" })

		const inline = await provider.addPrComment(ghPr, { body: "Nit", path: ".\\src\\a.ts", line: 12 })
		expect(inline).toEqual({ kind: "inline comment", url: "https://gh/r301", replyId: "301" })
		expect(api.lastJson("POST")).toEqual({ body: "Nit", commit_id: "abc123def", path: "src/a.ts", line: 12, side: "RIGHT" })

		expect(await provider.addPrComment(ghPr, { body: "Fixed", replyTo: "101" })).toEqual({
			kind: "reply",
			url: "https://gh/r302",
			replyId: "101",
		})
		expect(api.last("POST").url.pathname).toBe(`${GH}/pulls/7/comments/101/replies`)
		expect(api.lastJson("POST")).toEqual({ body: "Fixed" })
	})

	it("explains a line outside the diff and a reply to something that is not an inline thread", async () => {
		const api = new FakeApi()
			.on(
				"POST",
				`${GH}/pulls/7/comments`,
				{
					message: "Validation Failed",
					errors: [{ message: "pull_request_review_thread.line must be part of the diff" }],
				},
				422,
			)
			.on("POST", `${GH}/pulls/7/comments/5/replies`, { message: "Not Found" }, 404)
		const provider = github(api)
		await expect(provider.addPrComment(ghPr, { body: "x", path: "a.ts", line: 999 })).rejects.toThrow(
			/HTTP 422: Validation Failed \(pull_request_review_thread.line must be part of the diff\)\. GitHub takes inline comments only on lines/,
		)
		await expect(provider.addPrComment(ghPr, { body: "x", replyTo: "5" })).rejects.toThrow(
			"PR #7 has no inline review comment 5. GitHub threads replies only under inline review comments",
		)
		await expect(provider.addPrComment(ghPr, { body: "x", replyTo: "abc" })).rejects.toThrow("`reply_to` takes the id")
	})

	it("submits reviews with the matching event, and needs a body to request changes", async () => {
		const api = new FakeApi().on("POST", `${GH}/pulls/7/reviews`, { id: 1, html_url: "https://gh/review1" })
		const provider = github(api)
		expect(await provider.reviewPr(ghPr, "approve")).toBe("Approved PR #7 on GitHub: https://gh/review1")
		expect(api.lastJson("POST")).toEqual({ event: "APPROVE" })
		await provider.reviewPr(ghPr, "request_changes", "Add tests")
		expect(api.lastJson("POST")).toEqual({ event: "REQUEST_CHANGES", body: "Add tests" })
		await provider.reviewPr(ghPr, "comment", "Looks fine so far")
		expect(api.lastJson("POST")).toEqual({ event: "COMMENT", body: "Looks fine so far" })

		const before = api.requests.length
		await expect(provider.reviewPr(ghPr, "request_changes")).rejects.toThrow("GitHub needs a `body` to request changes")
		expect(api.requests).toHaveLength(before)
	})

	it("passes GitHub's refusal of a self-approval to the model", async () => {
		const api = new FakeApi().on(
			"POST",
			`${GH}/pulls/7/reviews`,
			{ message: "Unprocessable Entity", errors: ["Can not approve your own pull request"] },
			422,
		)
		await expect(github(api).reviewPr(ghPr, "approve")).rejects.toThrow(
			"HTTP 422: Unprocessable Entity (Can not approve your own pull request)",
		)
	})

	it("cancels a run and reruns it in place, all jobs or only the failed ones", async () => {
		const api = new FakeApi()
			.on("POST", `${GH}/actions/runs/42/cancel`, {}, 202)
			.on("POST", `${GH}/actions/runs/42/rerun`, {}, 201)
			.on("POST", `${GH}/actions/runs/42/rerun-failed-jobs`, {}, 201)
		const provider = github(api)
		await provider.cancelRun(42)
		expect(api.last("POST").url.pathname).toBe(`${GH}/actions/runs/42/cancel`)
		expect(api.last("POST").body).toBeUndefined()
		expect(await provider.rerunRun(42, false)).toEqual({ runId: 42, url: "https://github.com/octo/hello/actions/runs/42" })
		expect(api.last("POST").url.pathname).toBe(`${GH}/actions/runs/42/rerun`)
		await provider.rerunRun(42, true)
		expect(api.last("POST").url.pathname).toBe(`${GH}/actions/runs/42/rerun-failed-jobs`)
	})

	it("reports a cancel that GitHub refuses", async () => {
		const api = new FakeApi().on(
			"POST",
			`${GH}/actions/runs/42/cancel`,
			{ message: "Cannot cancel a workflow run that is completed." },
			409,
		)
		await expect(github(api).cancelRun(42)).rejects.toThrow("HTTP 409: Cannot cancel a workflow run that is completed.")
	})
})

const PROJ = "/acme/My Project/_apis"
const PRS = `${PROJ}/git/repositories/r-1/pullrequests`

const azdo = (api: FakeApi) => {
	api.on("GET", `${PROJ}/git/repositories/web-app`, { id: "r-1", defaultBranch: "refs/heads/main", project: { id: "p-1" } })
	return new AzureDevOpsProvider(
		{ kind: "ado", host: "dev.azure.com", owner: "acme", repo: "web-app", project: "My Project" },
		api.fetch,
		staticAuth(),
	)
}

const adoPr: PullRequest = { ...ghPr, id: 42, url: "https://dev.azure.com/acme/My%20Project/_git/web-app/pullrequest/42" }

describe("Azure DevOps review calls", () => {
	it("lists threads without system comments, with file:line and resolved state", async () => {
		const api = new FakeApi().on("GET", `${PRS}/42/threads`, {
			value: [
				{
					id: 3,
					status: "fixed",
					threadContext: { filePath: "/src/a.ts", rightFileStart: { line: 12, offset: 1 } },
					comments: [
						{
							id: 1,
							author: { displayName: "Jane" },
							content: "Rename",
							commentType: "text",
							publishedDate: "2026-10-02T10:00:00Z",
						},
						{
							id: 2,
							author: { displayName: "Bob" },
							content: "Done",
							commentType: "text",
							publishedDate: "2026-10-03T10:00:00Z",
						},
					],
				},
				{
					id: 4,
					status: "active",
					comments: [
						{
							id: 1,
							author: { displayName: "Ann" },
							content: "Why?",
							commentType: "text",
							publishedDate: "2026-10-04T10:00:00Z",
						},
					],
				},
				{ id: 5, comments: [{ id: 1, content: "Jane voted 10", commentType: "system" }] },
				{ id: 6, isDeleted: true, comments: [{ id: 1, content: "gone", commentType: "text" }] },
			],
		})
		const threads = await azdo(api).listPrThreads(adoPr)
		expect(threads).toEqual([
			{
				kind: "inline",
				replyId: "3",
				path: "src/a.ts",
				line: 12,
				resolved: true,
				url: "https://dev.azure.com/acme/My%20Project/_git/web-app/pullrequest/42?discussionId=3",
				comments: [
					{ author: "Jane", body: "Rename", created: "2026-10-02T10:00:00Z" },
					{ author: "Bob", body: "Done", created: "2026-10-03T10:00:00Z" },
				],
			},
			{
				kind: "general",
				replyId: "4",
				path: undefined,
				line: undefined,
				resolved: false,
				url: "https://dev.azure.com/acme/My%20Project/_git/web-app/pullrequest/42?discussionId=4",
				comments: [{ author: "Ann", body: "Why?", created: "2026-10-04T10:00:00Z" }],
			},
		])
		expect(api.last("GET").url.searchParams.get("api-version")).toBe("7.1")
	})

	it("posts a general comment as a new active thread", async () => {
		const api = new FakeApi().on("POST", `${PRS}/42/threads`, { id: 11 })
		const posted = await azdo(api).addPrComment(adoPr, { body: "Hello" })
		expect(api.lastJson("POST")).toEqual({
			comments: [{ parentCommentId: 0, content: "Hello", commentType: 1 }],
			status: 1,
		})
		expect(posted).toEqual({
			kind: "comment",
			url: "https://dev.azure.com/acme/My%20Project/_git/web-app/pullrequest/42?discussionId=11",
			replyId: "11",
		})
	})

	it("anchors an inline comment to the latest iteration and the file's change", async () => {
		const api = new FakeApi()
			.on("GET", `${PRS}/42/iterations`, { value: [{ id: 1 }, { id: 3 }, { id: 2 }] })
			.on("GET", `${PRS}/42/iterations/3/changes`, {
				changeEntries: [
					{ changeTrackingId: 4, item: { path: "/README.md" } },
					{ changeTrackingId: 5, item: { path: "/src/a.ts" } },
				],
			})
			.on("POST", `${PRS}/42/threads`, { id: 12 })
		const posted = await azdo(api).addPrComment(adoPr, { body: "Nit", path: "src/a.ts", line: 7 })
		const changes = api.requests.find((r) => r.url.pathname.endsWith("/iterations/3/changes"))
		expect(changes?.url.searchParams.get("$compareTo")).toBe("0")
		expect(api.lastJson("POST")).toEqual({
			comments: [{ parentCommentId: 0, content: "Nit", commentType: 1 }],
			status: 1,
			threadContext: {
				filePath: "/src/a.ts",
				rightFileStart: { line: 7, offset: 1 },
				rightFileEnd: { line: 7, offset: 1 },
			},
			pullRequestThreadContext: {
				changeTrackingId: 5,
				iterationContext: { firstComparingIteration: 1, secondComparingIteration: 3 },
			},
		})
		expect(posted.kind).toBe("inline comment")
	})

	it("refuses an inline comment on a file the PR does not change, before posting", async () => {
		const api = new FakeApi()
			.on("GET", `${PRS}/42/iterations`, { value: [{ id: 1 }] })
			.on("GET", `${PRS}/42/iterations/1/changes`, { changeEntries: [{ changeTrackingId: 1, item: { path: "/b.ts" } }] })
		await expect(azdo(api).addPrComment(adoPr, { body: "x", path: "a.ts", line: 1 })).rejects.toThrow(
			"a.ts is not among the files PR #42 changes",
		)
		expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0)
	})

	it("replies under the thread's first comment, and explains an unknown thread", async () => {
		const api = new FakeApi()
			.on("GET", `${PRS}/42/threads/9`, {
				id: 9,
				comments: [
					{ id: 1, commentType: "system", content: "policy" },
					{ id: 2, commentType: "text", content: "Why?" },
				],
			})
			.on("POST", `${PRS}/42/threads/9/comments`, { id: 3 })
			.on("GET", `${PRS}/42/threads/8`, { message: "TF401180: thread not found" }, 404)
		const provider = azdo(api)
		const posted = await provider.addPrComment(adoPr, { body: "Because", replyTo: "9" })
		expect(api.lastJson("POST")).toEqual({ content: "Because", parentCommentId: 2, commentType: 1 })
		expect(posted).toEqual({
			kind: "reply",
			url: "https://dev.azure.com/acme/My%20Project/_git/web-app/pullrequest/42?discussionId=9",
			replyId: "9",
		})
		await expect(provider.addPrComment(adoPr, { body: "x", replyTo: 8 as unknown as string })).rejects.toThrow(
			"PR #42 has no thread 8",
		)
	})

	it("votes as the signed-in user: approve 10, request_changes -5 (waiting for author), comment no vote", async () => {
		const api = new FakeApi()
			.on("GET", "/acme/_apis/connectionData", { authenticatedUser: { id: "u-1" } })
			.on("PUT", `${PRS}/42/reviewers/u-1`, { vote: 10 })
			.on("POST", `${PRS}/42/threads`, { id: 20 })
		const provider = azdo(api)
		expect(await provider.reviewPr(adoPr, "approve")).toBe(`Set your vote on PR #42 to Approved (10): ${adoPr.url}`)
		expect(api.lastJson("PUT")).toEqual({ vote: 10 })
		expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0)

		const out = await provider.reviewPr(adoPr, "request_changes", "Please add tests")
		expect(api.lastJson("PUT")).toEqual({ vote: -5 })
		expect(out).toContain("Waiting for author (-5)")
		expect(out).toContain("Posted the review comment:")
		expect((api.lastJson("POST") as { comments: { content: string }[] }).comments[0].content).toBe("Please add tests")

		const puts = api.requests.filter((r) => r.method === "PUT").length
		await provider.reviewPr(adoPr, "comment", "Just a note")
		expect(api.requests.filter((r) => r.method === "PUT")).toHaveLength(puts)
	})

	it("cancels a build, retries its failed jobs, and requeues it with the same definition, branch and parameters", async () => {
		const api = new FakeApi()
			.on("PATCH", `${PROJ}/build/builds/57`, { id: 57, _links: { web: { href: "https://ado/57" } } })
			.on("GET", `${PROJ}/build/builds/57`, {
				id: 57,
				definition: { id: 4 },
				sourceBranch: "refs/heads/main",
				sourceVersion: "abc",
				parameters: '{"system.debug":"true"}',
				templateParameters: { env: "dev" },
			})
			.on("POST", `${PROJ}/build/builds`, { id: 58, _links: { web: { href: "https://ado/58" } } })
		const provider = azdo(api)

		await provider.cancelRun(57)
		expect(api.lastJson("PATCH")).toEqual({ status: "cancelling" })
		expect(api.last("PATCH").url.searchParams.get("retry")).toBeNull()

		expect(await provider.rerunRun(57, true)).toEqual({ runId: 57, url: "https://ado/57" })
		expect(api.last("PATCH").url.searchParams.get("retry")).toBe("true")
		expect(api.lastJson("PATCH")).toEqual({})

		expect(await provider.rerunRun(57, false)).toEqual({ runId: 58, url: "https://ado/58" })
		expect(api.lastJson("POST")).toEqual({
			definition: { id: 4 },
			sourceBranch: "refs/heads/main",
			sourceVersion: "abc",
			parameters: '{"system.debug":"true"}',
			templateParameters: { env: "dev" },
		})
	})

	it("requeues a PR build on its merge ref without pinning the old merge commit", async () => {
		const api = new FakeApi()
			.on("GET", `${PROJ}/build/builds/60`, {
				id: 60,
				definition: { id: 4 },
				sourceBranch: "refs/pull/42/merge",
				sourceVersion: "m1",
			})
			.on("POST", `${PROJ}/build/builds`, { id: 61 })
		const dispatch = await azdo(api).rerunRun(60, false)
		expect(api.lastJson("POST")).toEqual({ definition: { id: 4 }, sourceBranch: "refs/pull/42/merge" })
		expect(dispatch).toEqual({ runId: 61, url: "https://dev.azure.com/acme/My%20Project/_build/results?buildId=61" })
	})

	it("reports a retry Azure DevOps refuses", async () => {
		const api = new FakeApi().on(
			"PATCH",
			`${PROJ}/build/builds/57`,
			{ message: "TF400898: Build 57 cannot be retried because it is still in progress." },
			400,
		)
		await expect(azdo(api).rerunRun(57, true)).rejects.toThrow("HTTP 400: TF400898: Build 57 cannot be retried")
	})
})

describe("Azure DevOps Server review calls", () => {
	const remote = parseRemote("https://tfs.internal.example.com/tfs/Coll/Meshing/_git/SomeRepo")
	const server = (api: FakeApi) => {
		api.on("GET", "/tfs/Coll/Meshing/_apis/git/repositories/SomeRepo", { id: "r-9", project: { id: "p-9" } })
		return new AzureDevOpsProvider(remote, api.fetch, staticAuth("Basic pat"))
	}
	const pr: PullRequest = { ...adoPr, id: 5 }

	it("votes and comments against the collection on the server's own host", async () => {
		const api = new FakeApi()
			.on("GET", "/tfs/Coll/_apis/connectionData", { authenticatedUser: { id: "u-9" } })
			.on("PUT", "/tfs/Coll/Meshing/_apis/git/repositories/r-9/pullrequests/5/reviewers/u-9", { vote: 10 })
			.on("POST", "/tfs/Coll/Meshing/_apis/git/repositories/r-9/pullrequests/5/threads", { id: 2 })
		const out = await server(api).reviewPr(pr, "approve", "Ship it")
		expect(api.last("PUT").url.href).toStartWith("https://tfs.internal.example.com/tfs/Coll/Meshing/_apis/")
		expect(api.last("PUT").headers.Authorization).toBe("Basic pat")
		expect(out).toContain("https://tfs.internal.example.com/tfs/Coll/Meshing/_git/SomeRepo/pullrequest/5?discussionId=2")
	})
})
