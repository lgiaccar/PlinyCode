import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { BROKER_PATH_ENV, BROKER_SECRET_ENV, type BrokerRequest } from "../../shared/broker-protocol"
import { requestBrokerToken } from "../auth"
import { GitHubProvider } from "../providers/github"
import { createTools, type ToolDefinition } from "../tools"
import { FakeApi, staticAuth } from "./fake-api"

const REPO = "/repos/octo/hello"

const pr = (body: string) => ({
	number: 7,
	title: "T",
	body,
	state: "open",
	draft: false,
	head: { ref: "feature", sha: "s" },
	base: { ref: "main" },
	user: { login: "u" },
	html_url: "https://github.com/octo/hello/pull/7",
})

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })

describe("tools against a temporary checkout", () => {
	let workspace: string
	let api: FakeApi
	let tools: Record<string, ToolDefinition>

	beforeEach(() => {
		workspace = fs.mkdtempSync(path.join(os.tmpdir(), "devops-mcp-"))
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

	it("refuses to open a PR for an unpushed branch", async () => {
		await expect(tools.pr_create.run({ title: "T", body: "B", workspace })).rejects.toThrow(/has not been pushed/)
		expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0)
	})

	it("defaults to the current branch and the repository's default branch", async () => {
		git(workspace, "update-ref", "refs/remotes/origin/feature", "HEAD") // as if pushed
		api.on("GET", `${REPO}/pulls`, []).on("GET", REPO, { default_branch: "main" }).on("POST", `${REPO}/pulls`, pr("B"))
		const out = await tools.pr_create.run({ title: "T", body: "B", draft: true, workspace })
		expect(api.lastJson("POST")).toEqual({ title: "T", body: "B", head: "feature", base: "main", draft: true })
		expect(out).toContain("Created pull request #7")
		expect(out).not.toContain("Warning")
	})

	it("updates only the named section of the description", async () => {
		api.on("GET", `${REPO}/pulls`, [pr("Hand-written.")]).on("PATCH", `${REPO}/pulls/7`, pr("ignored"))
		await tools.pr_update.run({ body: "CI ✅", section: "ci", workspace })
		expect(api.lastJson("PATCH")).toEqual({
			body: "Hand-written.\n\n<!-- devops-mcp:ci -->\nCI ✅\n<!-- /devops-mcp:ci -->\n",
		})
	})

	it("explains when the branch has no open PR", async () => {
		api.on("GET", `${REPO}/pulls`, [])
		await expect(tools.pr_get.run({ workspace })).rejects.toThrow("No open pull request for branch 'feature'")
	})

	it("reports a folder that is not a git repository", async () => {
		const plain = fs.mkdtempSync(path.join(os.tmpdir(), "devops-mcp-plain-"))
		try {
			await expect(tools.repo_context.run({ workspace: plain })).rejects.toThrow(/not inside a git repository/)
		} finally {
			fs.rmSync(plain, { recursive: true, force: true })
		}
	})
})

describe("token broker client", () => {
	const saved = { path: process.env[BROKER_PATH_ENV], secret: process.env[BROKER_SECRET_ENV] }

	afterEach(() => {
		process.env[BROKER_PATH_ENV] = saved.path
		process.env[BROKER_SECRET_ENV] = saved.secret
		if (saved.path === undefined) delete process.env[BROKER_PATH_ENV]
		if (saved.secret === undefined) delete process.env[BROKER_SECRET_ENV]
	})

	it("returns nothing when no broker is configured", async () => {
		delete process.env[BROKER_PATH_ENV]
		expect(await requestBrokerToken("github", "github.com", false)).toBeUndefined()
	})

	it("sends the secret and request, and reads the token back", async () => {
		const received: BrokerRequest[] = []
		const socketPath =
			process.platform === "win32"
				? `\\\\.\\pipe\\devops-mcp-test-${process.pid}`
				: path.join(os.tmpdir(), `devops-mcp-test-${process.pid}.sock`)
		const server = net.createServer((socket) => {
			socket.on("data", (chunk) => {
				const request = JSON.parse(chunk.toString().trim()) as BrokerRequest
				received.push(request)
				socket.end(`${JSON.stringify(request.provider === "ado" ? { token: "ado-token" } : { error: "no session" })}\n`)
			})
		})
		await new Promise<void>((resolve) => server.listen(socketPath, resolve))
		try {
			process.env[BROKER_PATH_ENV] = socketPath
			process.env[BROKER_SECRET_ENV] = "s3cret"
			expect(await requestBrokerToken("ado", "dev.azure.com", true)).toBe("ado-token")
			expect(await requestBrokerToken("github", "github.com", false)).toBeUndefined()
			expect(received).toEqual([
				{ secret: "s3cret", provider: "ado", host: "dev.azure.com", interactive: true },
				{ secret: "s3cret", provider: "github", host: "github.com", interactive: false },
			])
		} finally {
			server.close()
		}
	})
})
