import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { RepoContext } from "../../server/repo"
import { CiBoard } from "../ci-board"
import { CiBoardStore } from "../ci-board-store"
import { CI_BOARD_MARKER } from "../ci-prompt"
import { boardPr, boardRun, FakeBoardProvider, SHA_A } from "./fake-board-provider"

const GH_REMOTE = { kind: "github" as const, host: "github.com", owner: "octo", repo: "hello" }

describe("CiBoard", () => {
	let dir: string
	let provider: FakeBoardProvider
	let checkout: string | undefined
	let repoCtx: RepoContext
	let board: CiBoard

	const makeBoard = () =>
		new CiBoard({
			store: new CiBoardStore(path.join(dir, "ci-board.json")),
			workspacePath: "/window",
			providerFor: () => provider,
			resolveCheckout: async () => checkout,
			maxPrsPerRepo: () => 30,
			worktreeFolder: () => path.join(dir, "worktrees"),
			loadRepo: async () => repoCtx,
		})

	beforeEach(async () => {
		dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ci-board-")))
		provider = new FakeBoardProvider()
		provider.prs = [boardPr(12, { sourceBranch: "feature", url: "https://github.com/octo/hello/pull/12" })]
		provider.runs.set(SHA_A, [boardRun(1, "ci", "completed", "failure")])
		checkout = undefined
		repoCtx = {
			root: path.join(dir, "repo"),
			remoteName: "origin",
			remote: GH_REMOTE,
			remoteUrl: "git@github.com:octo/hello.git",
			branch: "main",
		}
		board = makeBoard()
		await board.init()
	})

	afterEach(() => {
		board.dispose()
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it("adds a PR link once, and saves it for the window's workspace", async () => {
		const a = await board.addTarget({ kind: "pr", url: "https://github.com/octo/hello/pull/12" })
		const b = await board.addTarget({ kind: "pr", url: "https://github.com/octo/hello/pull/12/files" })
		expect(b.id).toBe(a.id)
		expect([a.kind, a.prId, a.provider, a.autoWatch, a.actions.map((x) => x.id)]).toEqual([
			"pr",
			12,
			"github",
			false,
			["fix-conflicts", "fix-build", "recalibrate", "fix-ci", "investigate"],
		])

		const reopened = makeBoard()
		await reopened.init()
		expect(reopened.view().map((v) => v.target.id)).toEqual([a.id])
		reopened.dispose()
	})

	it("adds a workspace repository's branch and its open PRs, keeping the git remote URL", async () => {
		const branch = await board.addTarget({ kind: "branch", repoRoot: repoCtx.root, branch: " feature " })
		const repo = await board.addTarget({ kind: "repo", repoRoot: repoCtx.root, prFilter: "mine" })
		expect([branch.branch, branch.remoteUrl, branch.repoRoot]).toEqual([
			"feature",
			"git@github.com:octo/hello.git",
			repoCtx.root,
		])
		expect(repo.prFilter).toBe("mine")
		// The SSH and HTTPS URLs of one repository are the same selection.
		const again = await board.addTarget({ kind: "branch", repoRoot: repoCtx.root, branch: "feature" })
		expect(again.id).toBe(branch.id)
	})

	it("rejects a branch name git would not accept", async () => {
		await expect(board.addTarget({ kind: "branch", repoRoot: repoCtx.root, branch: "two words" })).rejects.toThrow(
			/not a valid branch name/,
		)
	})

	it("rejects a link that is not a pull request", async () => {
		await expect(board.addTarget({ kind: "pr", url: "https://github.com/octo/hello" })).rejects.toThrow(
			/not a pull request link/,
		)
	})

	it("updates and removes targets, and keeps links", async () => {
		const t = await board.addTarget({ kind: "pr", url: "https://github.com/octo/hello/pull/12" })
		await board.updateTarget(t.id, { autoWatch: true })
		expect(board.target(t.id)?.autoWatch).toBe(true)
		await board.setLink("k", { conversationId: "c1", actionId: "fix", worktree: "/w", startedTs: 1 })
		expect(board.linkFor("k")?.conversationId).toBe("c1")
		await board.removeTarget(t.id)
		expect(board.view()).toEqual([])
		await expect(board.updateTarget(t.id, {})).rejects.toThrow(/no longer exists/)
	})

	it("runs direct Azure DevOps actions without a checkout and validates fresh policy state", async () => {
		const url = "https://dev.azure.com/acme/P/_git/r/pullrequest/12"
		provider.prs = [boardPr(12, { url })]
		const evaluationId = "11111111-1111-4111-8111-111111111111"
		let policyStatus = "approved"
		let restartError: Error | undefined
		const restarted: number[] = []
		const requeued: string[] = []
		Object.assign(provider, {
			listBuildPolicies: async () => [{ evaluationId, name: "CI", expired: false, status: policyStatus }],
			requeueBuildPolicy: async (id: string) => {
				requeued.push(id)
				policyStatus = "queued"
			},
			restartPrMerge: async (id: number) => {
				if (restartError) throw restartError
				restarted.push(id)
			},
		})
		const target = await board.addTarget({ kind: "pr", url })
		await board.refresh()
		const item = board.view()[0].items[0]
		expect(item.buildPolicies).toHaveLength(1)
		expect(item.expiredBuildPolicies).toEqual([])
		await board.runProviderAction(target.id, item.key, "restart-merge")
		expect(restarted).toEqual([12])
		await expect(board.runProviderAction(target.id, item.key, "requeue-pipeline", "foreign-policy")).rejects.toThrow(
			/changed/,
		)
		await board.runProviderAction(target.id, item.key, "requeue-pipeline", evaluationId)
		expect(requeued).toEqual([evaluationId])
		expect(board.view()[0].items[0].buildPolicies?.[0].status).toBe("queued")
		await expect(board.runProviderAction(target.id, item.key, "requeue-pipeline", evaluationId)).rejects.toThrow(
			/already queued/,
		)
		restartError = new Error("server unavailable")
		await expect(board.runProviderAction(target.id, item.key, "restart-merge")).rejects.toThrow(/unavailable/)
		restartError = undefined
		await board.runProviderAction(target.id, item.key, "restart-merge")
		provider.prs[0].state = "merged"
		await expect(board.runProviderAction(target.id, item.key, "restart-merge")).rejects.toThrow(/no longer open/)
		expect(restarted).toEqual([12, 12])
		expect(board.linkFor(item.key)).toBeUndefined()
	})

	it("rejects GitHub items and concurrent provider actions", async () => {
		const gh = await board.addTarget({ kind: "pr", url: "https://github.com/octo/hello/pull/12" })
		await board.refresh()
		await expect(board.runProviderAction(gh.id, board.view()[0].items[0].key, "restart-merge")).rejects.toThrow(
			/Azure DevOps/,
		)
		const url = "https://dev.azure.com/acme/P/_git/r/pullrequest/12"
		provider.prs = [boardPr(12, { url })]
		let release!: () => void
		Object.assign(provider, {
			restartPrMerge: () =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		})
		const target = await board.addTarget({ kind: "pr", url })
		await board.refresh()
		const item = board.view().find((v) => v.target.id === target.id)!.items[0]
		const first = board.runProviderAction(target.id, item.key, "restart-merge")
		await Promise.resolve()
		await expect(board.runProviderAction(target.id, item.key, "restart-merge")).rejects.toThrow(/already running/)
		release()
		await first
	})

	it("requeues only a currently expired Azure DevOps validation and refreshes the board", async () => {
		const url = "https://dev.azure.com/acme/P/_git/r/pullrequest/12"
		provider.prs = [boardPr(12, { url })]
		const evaluationId = "11111111-1111-4111-8111-111111111111"
		let expired = true
		let requeueError: Error | undefined
		const requeued: string[] = []
		Object.assign(provider, {
			listExpiredBuildPolicies: async () => (expired ? [{ evaluationId, name: "Build validation" }] : []),
			requeueBuildPolicy: async (id: string) => {
				if (requeueError) throw requeueError
				requeued.push(id)
				expired = false
			},
		})
		const target = await board.addTarget({ kind: "pr", url })
		await board.refresh()
		const item = board.view()[0].items[0]
		expect(item.expiredBuildPolicies?.[0]?.evaluationId).toBe(evaluationId)
		await expect(board.requeueExpiredBuildPolicy(target.id, item.key, "missing")).rejects.toThrow(/changed/)
		expect(requeued).toEqual([])
		requeueError = new Error("Azure DevOps is unavailable")
		await expect(board.requeueExpiredBuildPolicy(target.id, item.key, evaluationId)).rejects.toThrow(/unavailable/)
		expect(board.view()[0].items[0].expiredBuildPolicies).toHaveLength(1)
		requeueError = undefined
		await board.requeueExpiredBuildPolicy(target.id, item.key, evaluationId)
		expect(requeued).toEqual([evaluationId])
		expect(board.view()[0].items[0].expiredBuildPolicies).toEqual([])
	})

	it("blocks runs without a checkout, on forks and on closed PRs", async () => {
		const t = await board.addTarget({ kind: "pr", url: "https://github.com/octo/hello/pull/12" })
		await board.refresh()
		const [item] = board.view()[0].items
		expect(board.runBlockedReason(t, item)).toContain("No folder open in this window")
		await expect(board.prepareRun(t.id, item.key, { actionId: "fix-ci" })).rejects.toThrow(/No folder open/)
		checkout = repoCtx.root
		await board.rescanCheckouts()
		expect(board.runBlockedReason(t, item)).toBeUndefined()
		expect(board.runBlockedReason(t, { ...item, fork: true })).toContain("fork")
		expect(board.runBlockedReason(t, { ...item, pr: boardPr(12, { state: "merged" }) })).toContain("merged")
	})

	it("prepares a run in a worktree of the PR branch, with the PR's context ahead of the prompt", async () => {
		const origin = path.join(dir, "origin")
		fs.mkdirSync(origin)
		const git = (cwd: string, ...args: string[]) =>
			execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdio: "pipe" })
		git(origin, "init", "-q", "-b", "main")
		git(origin, "commit", "-q", "--allow-empty", "-m", "init")
		git(origin, "branch", "feature")
		execFileSync("git", ["clone", "-q", origin, repoCtx.root], { stdio: "pipe" })
		checkout = repoCtx.root

		const t = await board.addTarget({ kind: "pr", url: "https://github.com/octo/hello/pull/12" })
		await board.refresh()
		const [item] = board.view()[0].items
		const run = await board.prepareRun(t.id, item.key, { actionId: "fix-ci" })
		expect(run.worktree.created).toBe(true)
		expect(run.worktree.path).toBe(path.join(dir, "worktrees", "repo", "feature"))
		expect(run.prompt.startsWith(`${CI_BOARD_MARKER} PR #12`)).toBe(true)
		expect(run.prompt).toContain("- ✗ ci: failure (run 1)")
		expect(run.prompt).toContain("Fix them all: get this pull request green")
		expect(run.prompt).not.toContain("Scope:")
		expect(run.pipeline).toBeUndefined()

		const scoped = await board.prepareRun(t.id, item.key, { actionId: "fix-build", pipeline: "ci" })
		expect(scoped.pipeline).toBe("ci")
		expect(scoped.prompt).toContain("Scope:\n- Fix only the pipeline ci (run 1).")
		expect(scoped.prompt).toContain("# Fix a failing pipeline")
		await expect(board.prepareRun(t.id, item.key, { actionId: "fix-build", pipeline: "gone" })).rejects.toThrow(
			/no longer on this pull request/,
		)
		expect([run.mode, run.sourceBranch, run.remoteName]).toEqual(["act", "feature", "origin"])
		expect(run.reportDir).toBe(path.join(repoCtx.root, ".plinycode", "ci-reports"))

		const investigate = await board.prepareRun(t.id, item.key, { actionId: "investigate" })
		expect(investigate.mode).toBe("ask")
		expect(investigate.prompt).toContain("read-only investigation")

		const custom = await board.prepareRun(t.id, item.key, {
			custom: { kind: "text", text: "Rebase {{sourceBranch}} please" },
			label: "Mine",
			model: "current",
		})
		expect([custom.action.label, custom.action.model, custom.mode]).toEqual(["Mine", "current", "act"])
		expect(custom.prompt).toEndWith("Rebase feature please")
	}, 30_000)

	it("keeps auto-watch counters, and forgets an item's when asked", async () => {
		await board.recordAutoAttempt(["k|fix-conflicts|a", "k|fix-conflicts"])
		await board.recordAutoAttempt(["k|fix-conflicts|a"])
		expect([board.autoAttempts("k|fix-conflicts|a"), board.autoAttempts("k|fix-conflicts")]).toEqual([2, 1])
		await board.resetAutoAttempts("k|")
		expect(board.autoAttempts("k|fix-conflicts|a")).toBe(0)
	})

	it("keeps the built-in actions when the actions are replaced", async () => {
		const t = await board.addTarget({ kind: "pr", url: "https://github.com/octo/hello/pull/12" })
		const next = await board.updateTarget(t.id, {
			actions: [
				{ id: "mine", label: "Mine", prompt: { kind: "text", text: "x" }, model: "free", situation: "any", auto: true },
				{ ...t.actions[2], auto: false, label: "Recal" },
			],
		})
		expect(next.actions.map((a) => a.id)).toEqual([
			"fix-conflicts",
			"fix-build",
			"recalibrate",
			"fix-ci",
			"investigate",
			"mine",
		])
		expect(next.actions[2]).toMatchObject({ id: "recalibrate", label: "Recal", auto: false })
	})
})
