/** The review and pipeline control tools against a temporary checkout and recorded API responses. */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AzureDevOpsProvider } from "../providers/azdo"
import { GitHubProvider } from "../providers/github"
import { createTools, type ToolDefinition } from "../tools"
import { FakeApi, staticAuth } from "./fake-api"

const REPO = "/repos/octo/hello"

const pr = (overrides: Record<string, unknown> = {}) => ({
	number: 7,
	title: "T",
	body: "",
	state: "open",
	draft: false,
	head: { ref: "feature", sha: "head-sha" },
	base: { ref: "main" },
	user: { login: "u" },
	html_url: "https://github.com/octo/hello/pull/7",
	...overrides,
})

const run = (overrides: Record<string, unknown> = {}) => ({
	id: 42,
	name: "Build",
	status: "completed",
	conclusion: "failure",
	head_branch: "feature",
	html_url: "https://github.com/octo/hello/actions/runs/42",
	workflow_id: 3,
	...overrides,
})

const WORKFLOW_YAML = `on:
  workflow_dispatch:
    inputs:
      enabled: {type: boolean, default: false}
      count: {type: number, default: 1}
      target: {type: choice, options: [dev, prod], required: true}
`

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })

describe("review and pipeline tools", () => {
	let workspace: string
	let api: FakeApi
	let tools: Record<string, ToolDefinition>

	const withWorkflow = () =>
		api
			.on("GET", `${REPO}/actions/workflows`, {
				workflows: [{ id: 3, name: "Build", state: "active", path: ".github/workflows/build.yml" }],
			})
			.on("GET", `${REPO}/actions/workflows/3`, { path: ".github/workflows/build.yml", state: "active" })
			.on("GET", `${REPO}/contents/.github/workflows/build.yml`, {
				sha: "yaml-sha",
				encoding: "base64",
				content: Buffer.from(WORKFLOW_YAML).toString("base64"),
			})
			.on("GET", REPO, { default_branch: "main" })
			.on("POST", `${REPO}/actions/workflows/3/dispatches`, {
				workflow_run_id: 77,
				html_url: "https://github.com/octo/hello/actions/runs/77",
			})

	beforeEach(() => {
		workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devops-mcp-review-"))
		git(workspace, "init", "-q", "-b", "feature")
		git(workspace, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init")
		git(workspace, "remote", "add", "origin", "git@github.com:octo/hello.git")
		api = new FakeApi()
		const provider = new GitHubProvider(
			{ kind: "github", host: "github.com", owner: "octo", repo: "hello" },
			api.fetch,
			staticAuth(),
		)
		tools = Object.fromEntries(createTools(() => provider).map((t) => [t.name, t]))
	})

	afterEach(() => {
		fs.rmSync(workspace, { recursive: true, force: true })
	})

	it("lists the current branch's PR comments, newest thread first, clipped, with reply ids", async () => {
		api.on("GET", `${REPO}/pulls`, [pr()])
			.on("GET", `${REPO}/issues/7/comments`, [
				{ id: 1, user: { login: "bob" }, body: `Long ${"x".repeat(400)}`, created_at: "2026-10-01T10:00:00Z" },
			])
			.on("GET", `${REPO}/pulls/7/comments`, [
				{
					id: 101,
					path: "src/a.ts",
					line: 12,
					user: { login: "jane" },
					body: "Rename\nthis",
					created_at: "2026-10-05T10:00:00Z",
				},
			])
			.on("GET", `${REPO}/pulls/7/reviews`, [])
			.on("POST", "/graphql", {
				data: {
					repository: {
						pullRequest: {
							reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [{ databaseId: 101 }] } }] },
						},
					},
				},
			})
		const out = await tools.pr_comments.run({ workspace })
		expect(api.requests[0].url.searchParams.get("head")).toBe("octo:feature")
		const lines = out.split("\n")
		expect(lines[0]).toBe("Comments on PR #7 (GitHub), newest first: 2 of 2 threads, 1 unresolved.")
		expect(out.indexOf("Inline src/a.ts:12 · unresolved · reply_to: 101")).toBeLessThan(out.indexOf("General comment"))
		expect(out).toContain("  - jane, 2026-10-05 10:00: Rename this")
		expect(out).toContain(`Long ${"x".repeat(295)}…`)
		expect(out).not.toContain("x".repeat(300))

		const one = await tools.pr_comments.run({ workspace, limit: 1 })
		expect(one).toContain("1 older threads are not shown")
	})

	it("checks pr_comment arguments before calling the API", async () => {
		await expect(tools.pr_comment.run({ body: " ", workspace })).rejects.toThrow("`body` is empty")
		await expect(tools.pr_comment.run({ body: "x", path: "a.ts", workspace })).rejects.toThrow(
			"`path` and `line` go together",
		)
		await expect(tools.pr_comment.run({ body: "x", path: "a.ts", line: 3, reply_to: 5, workspace })).rejects.toThrow(
			"pass `reply_to` or `path` and `line`, not both",
		)
		expect(api.requests).toHaveLength(0)
	})

	it("posts an inline comment on the PR's head commit and says how to reply", async () => {
		api.on("POST", `${REPO}/pulls/7/comments`, { id: 301, html_url: "https://gh/r301" }, 201).on(
			"GET",
			`${REPO}/pulls/7`,
			pr(),
		)
		const out = await tools.pr_comment.run({ pr_id: 7, body: "Nit", path: "src/a.ts", line: 3, workspace })
		expect(api.lastJson("POST")).toMatchObject({ commit_id: "head-sha", path: "src/a.ts", line: 3 })
		expect(out).toBe(
			"Posted an inline comment on src/a.ts:3 on PR #7: https://gh/r301\nTo reply in this thread, pass reply_to: 301.",
		)
	})

	it("reviews only open PRs, and a comment verdict needs a body", async () => {
		await expect(tools.pr_review.run({ verdict: "comment", workspace })).rejects.toThrow("needs a `body`")
		api.on("GET", `${REPO}/pulls/7`, pr({ state: "closed", merged_at: "2026-10-01T00:00:00Z" }))
		await expect(tools.pr_review.run({ pr_id: 7, verdict: "approve", workspace })).rejects.toThrow(
			"PR #7 is merged; only an open pull request can be reviewed.",
		)
		expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0)

		api.on("GET", `${REPO}/pulls`, [pr()]).on("POST", `${REPO}/pulls/7/reviews`, { html_url: "https://gh/rev" })
		expect(await tools.pr_review.run({ verdict: "approve", workspace })).toBe("Approved PR #7 on GitHub: https://gh/rev")
	})

	it("cancels only an unfinished run", async () => {
		api.on("GET", `${REPO}/actions/runs/42`, run())
		await expect(tools.pipeline_cancel.run({ run_id: "42", workspace })).rejects.toThrow(
			"Run 42 (Build) already finished: failure. There is nothing to cancel",
		)
		expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0)

		api.on("GET", `${REPO}/actions/runs/42`, run({ status: "in_progress", conclusion: null })).on(
			"POST",
			`${REPO}/actions/runs/42/cancel`,
			{},
			202,
		)
		const out = await tools.pipeline_cancel.run({ run_id: 42, workspace })
		expect(out).toContain("Asked GitHub to cancel run 42 (Build on feature, in progress)")
	})

	it("reruns only a finished run, and failed_only only when something failed", async () => {
		api.on("GET", `${REPO}/actions/runs/42`, run({ status: "in_progress", conclusion: null }))
		await expect(tools.pipeline_rerun.run({ run_id: 42, workspace })).rejects.toThrow("is still in progress")
		api.on("GET", `${REPO}/actions/runs/42`, run({ conclusion: "success" }))
		await expect(tools.pipeline_rerun.run({ run_id: 42, failed_only: true, workspace })).rejects.toThrow(
			"succeeded, so no job failed",
		)
		expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0)

		api.on("GET", `${REPO}/actions/runs/42`, run()).on("POST", `${REPO}/actions/runs/42/rerun-failed-jobs`, {}, 201)
		expect(await tools.pipeline_rerun.run({ run_id: 42, failed_only: true, workspace })).toBe(
			"Rerunning the failed jobs of run 42 (Build on feature) as a new attempt of the same run: https://github.com/octo/hello/actions/runs/42",
		)
	})

	it("refuses to run a pipeline on a branch that was never pushed", async () => {
		withWorkflow()
		await expect(tools.pipeline_run.run({ pipeline: "Build", inputs: { target: "dev" }, workspace })).rejects.toThrow(
			/has not been pushed.*Push it, or pass `branch`/,
		)
		expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0)
	})

	it("runs the pushed current branch by workflow file name, with text inputs turned into their types", async () => {
		git(workspace, "update-ref", "refs/remotes/origin/feature", "HEAD")
		withWorkflow()
		const out = await tools.pipeline_run.run({
			pipeline: "build.yml",
			inputs: '{"enabled": "true", "count": "3", "target": "prod"}',
			workspace,
		})
		expect(api.lastJson("POST")).toEqual({ ref: "feature", inputs: { enabled: true, count: 3, target: "prod" } })
		expect(out).toContain("Queued Build on feature (GitHub): run 77, https://github.com/octo/hello/actions/runs/77")
		expect(out).toContain('Inputs: {"enabled":true,"count":3,"target":"prod"}')
		expect(out).not.toContain("Pipelines view")
	})

	it("refuses unknown pipelines and bad inputs with what would work", async () => {
		withWorkflow()
		await expect(tools.pipeline_run.run({ pipeline: "Deploy", branch: "main", workspace })).rejects.toThrow(
			"No pipeline 'Deploy' can be run here. Pipelines: Build (id 3).",
		)
		await expect(
			tools.pipeline_run.run({ pipeline: 3, branch: "main", inputs: { target: "staging" }, workspace }),
		).rejects.toThrow(
			'Invalid value for parameter \'target\'.\nThe pipeline\'s inputs:\n- enabled: boolean, default false\n- count: number, default 1\n- target: choice, one of "dev", "prod", required',
		)
		await expect(tools.pipeline_run.run({ pipeline: 3, branch: "main", inputs: "[1]", workspace })).rejects.toThrow(
			"`inputs` must be an object",
		)
		expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0)
	})

	it("hands the prepared launch to the launcher the extension host passes", async () => {
		withWorkflow()
		const provider = new GitHubProvider(
			{ kind: "github", host: "github.com", owner: "octo", repo: "hello" },
			api.fetch,
			staticAuth(),
		)
		const launched: unknown[] = []
		const recorded = Object.fromEntries(
			createTools(
				() => provider,
				async ({ ctx, prepared }) => {
					launched.push({ root: ctx.root, pipeline: prepared.pipeline.id, ref: prepared.ref, inputs: prepared.inputs })
					return { runId: 5, url: "https://run/5", recorded: true }
				},
			).map((t) => [t.name, t]),
		)
		const out = await recorded.pipeline_run.run({ pipeline: "Build", branch: "main", inputs: { target: "dev" }, workspace })
		expect(launched).toEqual([{ root: expect.any(String), pipeline: 3, ref: "main", inputs: { target: "dev" } }])
		expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0)
		expect(out).toContain("It is in the Pipelines view's run history, which tells the user when it finishes.")
	})
})

describe("pipeline_rerun on Azure DevOps", () => {
	it("says a full rerun is a new build", async () => {
		const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devops-mcp-ado-"))
		try {
			git(workspace, "init", "-q", "-b", "main")
			git(workspace, "remote", "add", "origin", "https://dev.azure.com/acme/My%20Project/_git/web-app")
			const PROJ = "/acme/My Project/_apis"
			const api = new FakeApi()
				.on("GET", `${PROJ}/build/builds/57`, {
					id: 57,
					status: "completed",
					result: "failed",
					definition: { id: 4, name: "CI" },
					buildNumber: "20261017.1",
					sourceBranch: "refs/heads/main",
				})
				.on("POST", `${PROJ}/build/builds`, { id: 58, _links: { web: { href: "https://ado/58" } } })
			const provider = new AzureDevOpsProvider(
				{ kind: "ado", host: "dev.azure.com", owner: "acme", repo: "web-app", project: "My Project" },
				api.fetch,
				staticAuth(),
			)
			const tools = Object.fromEntries(createTools(() => provider).map((t) => [t.name, t]))
			expect(await tools.pipeline_rerun.run({ run_id: 57, workspace })).toBe(
				"Queued run 58 of CI on main with the same parameters, to rerun 57: https://ado/58",
			)
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true })
		}
	})
})
