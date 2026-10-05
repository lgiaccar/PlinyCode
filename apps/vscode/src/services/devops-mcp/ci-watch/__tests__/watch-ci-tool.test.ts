import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AgentToolContext } from "@plinycode/shared"
import { CiWatchManager } from "../ci-watch-manager"
import { resolveCiWatchTarget } from "../ci-watch-source"
import { ciWatchTools, createWatchCiTool } from "../watch-ci-tool"
import { FakeClock, FakeHost, FakeProvider, fakeContext, HEAD_A, run, SECOND } from "./fakes"

const context = (overrides: Partial<AgentToolContext> = {}): AgentToolContext => ({
	sessionId: "c1",
	agentId: "agent",
	iteration: 1,
	...overrides,
})

describe("watch_ci", () => {
	let clock: FakeClock
	let host: FakeHost
	let manager: CiWatchManager
	let provider: FakeProvider
	let opened: string[]

	beforeEach(() => {
		clock = new FakeClock()
		host = new FakeHost()
		manager = new CiWatchManager(host, { clock })
		provider = new FakeProvider()
		opened = []
	})

	const tool = () =>
		createWatchCiTool({
			cwd: "/work/repo",
			manager,
			openRepo: async (cwd) => {
				opened.push(cwd)
				return { ctx: fakeContext(), provider }
			},
		})

	it("watches the open pull request of the current branch and tells the model to end its turn", async () => {
		const result = (await tool().execute({}, context())) as string
		expect(opened).toEqual(["/work/repo"])
		expect(result).toStartWith(
			"Watching CI for PR #7 (feature → main) at commit aaaaaaaa on GitHub, until every run has finished.",
		)
		expect(result).toContain("Do not poll and do not call wait. Finish your turn now")
		expect(result).toContain("[CI WATCHER]")
		expect(manager.watching("c1")).toBe("PR #7 (feature → main)")

		// The watch it registered reports into the calling conversation.
		provider.runs = [run(1, "completed", "success")]
		await clock.advance(60 * SECOND)
		expect(host.delivered.map((d) => d.conversationId)).toEqual(["c1"])
	})

	it("accepts a pull request number sent as a string, and first_failure", async () => {
		const result = (await tool().execute({ pr: "7", until: "first_failure" }, context())) as string
		expect(result).toContain("until a run fails or all of them finish.")
		provider.runs = [run(1, "completed", "failure"), run(2, "in_progress")]
		await clock.advance(30 * SECOND)
		expect(host.delivered).toHaveLength(1)
		expect(host.delivered[0].prompt).toContain("CI has a failed run for PR #7")
	})

	it("reports a pull request that does not exist instead of watching", async () => {
		await expect(tool().execute({ pr: 99 }, context())).rejects.toThrow(/404/)
		await expect(tool().execute({ pr: "soon" }, context())).rejects.toThrow(/must be a pull request number/)
		expect(manager.watching("c1")).toBeUndefined()
	})

	it("says so when it replaces the conversation's watch", async () => {
		await tool().execute({}, context())
		const result = (await tool().execute({}, context())) as string
		expect(result).toContain("This replaces the previous watch on PR #7 (feature → main).")
	})

	it("cancels the watch", async () => {
		expect(await tool().execute({ cancel: true }, context())).toBe("This conversation has no CI watch to stop.")
		await tool().execute({}, context())
		expect(await tool().execute({ cancel: true }, context())).toBe("Stopped watching CI for PR #7 (feature → main).")
		expect(manager.watching("c1")).toBeUndefined()
		expect(opened).toHaveLength(1)
	})

	it("is refused for sub-agents, whose run ends before CI does", async () => {
		const subAgent = context({ snapshot: { parentAgentId: "root" } as AgentToolContext["snapshot"] })
		await expect(tool().execute({}, subAgent)).rejects.toThrow(/main agent/)
		expect(manager.watching("c1")).toBeUndefined()
	})

	it("is offered only while plinycode.ci.watch is on and a controller can receive the result", () => {
		const options = { cwd: "/work/repo", openRepo: async () => ({ ctx: fakeContext(), provider }) }
		expect(ciWatchTools({ ...options, enabled: true, manager }).map((t) => t.name)).toEqual(["watch_ci"])
		expect(ciWatchTools({ ...options, enabled: false, manager })).toEqual([])
		expect(ciWatchTools({ ...options, enabled: true, manager: undefined })).toEqual([])
	})
})

describe("resolveCiWatchTarget on a branch without a pull request", () => {
	let workspace: string
	let provider: FakeProvider
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", workspace, ...args], { stdio: "pipe" })
			.toString()
			.trim()
	const commit = (message: string) =>
		git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", message)

	beforeEach(() => {
		workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ci-watch-"))
		git("init", "-q", "-b", "feature")
		commit("init")
		provider = new FakeProvider()
		provider.pr = undefined
	})

	afterEach(() => {
		fs.rmSync(workspace, { recursive: true, force: true })
	})

	it("refuses a branch that was never pushed", async () => {
		const repo = { ctx: fakeContext(workspace), provider }
		await expect(resolveCiWatchTarget(repo, {})).rejects.toThrow(/has not been pushed, so there is no CI to watch/)
	})

	it("watches the pushed head commit and warns about commits that are not pushed", async () => {
		const pushed = git("rev-parse", "HEAD")
		git("update-ref", "refs/remotes/origin/feature", "HEAD") // as if pushed
		const repo = { ctx: fakeContext(workspace), provider }
		expect(await resolveCiWatchTarget(repo, {})).toEqual({
			label: "branch feature",
			branch: "feature",
			head: pushed,
			warnings: [],
		})

		commit("local only")
		const target = await resolveCiWatchTarget(repo, { branch: "feature" })
		expect(target.head).toBe(pushed)
		expect(target.warnings).toEqual(["Branch 'feature' has 1 local commit(s) not pushed to origin."])
	})

	it("needs a branch or a pull request when HEAD is detached", async () => {
		const repo = { ctx: fakeContext(workspace, true), provider }
		await expect(resolveCiWatchTarget(repo, {})).rejects.toThrow(/HEAD is detached/)
	})

	it("prefers the branch's open pull request", async () => {
		provider = new FakeProvider()
		const target = await resolveCiWatchTarget({ ctx: fakeContext(workspace), provider }, { branch: "feature" })
		expect(target).toMatchObject({ label: "PR #7 (feature → main)", head: HEAD_A })
	})
})
