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

	it("merges a green PR at the selected head without a local checkout", async () => {
		provider.runs.set(SHA_A, [boardRun(2, "ci", "completed", "success")])
		const merged: unknown[] = []
		Object.assign(provider, {
			mergePr: async (...args: unknown[]) => {
				merged.push(args)
			},
		})
		const target = await board.addTarget({ kind: "pr", url: provider.prs[0].url })
		await board.refresh(target.id)
		const item = board.view()[0].items[0]
		await board.runProviderAction(target.id, item.key, "merge-pr", "", 0, SHA_A, "main")
		expect(merged).toEqual([[12, SHA_A]])
	})

	it.each(["failure", "skipped", "cancelled", "pending", "missing"])("refuses merge when CI is %s", async (result) => {
		let merged = false
		Object.assign(provider, {
			mergePr: async () => {
				merged = true
			},
		})
		const target = await board.addTarget({ kind: "pr", url: provider.prs[0].url })
		await board.refresh(target.id)
		const item = board.view()[0].items[0]
		provider.runs.set(
			SHA_A,
			result === "missing" ? [] : [boardRun(2, "ci", result === "pending" ? "in_progress" : "completed", result)],
		)
		await expect(board.runProviderAction(target.id, item.key, "merge-pr", "", 0, SHA_A, "main")).rejects.toThrow(/green/)
		expect(merged).toBe(false)
	})

	it("revalidates checks, policies and PR state, and releases the action lock after failures", async () => {
		provider.runs.set(SHA_A, [boardRun(2, "ci", "completed", "success")])
		let merges = 0
		let checks: unknown[] = [{ name: "review", status: "in_progress" }]
		let policies: unknown[] = []
		Object.assign(provider, {
			mergePr: async () => {
				merges++
			},
			prChecks: async () => checks,
			listBuildPolicies: async () => policies,
		})
		const target = await board.addTarget({ kind: "pr", url: provider.prs[0].url })
		await board.refresh(target.id)
		const item = board.view()[0].items[0]
		const merge = () => board.runProviderAction(target.id, item.key, "merge-pr", "", 0, SHA_A, "main")
		await expect(merge()).rejects.toThrow(/has not passed/)
		checks = [{ name: "review", status: "completed", result: "failure" }]
		await expect(merge()).rejects.toThrow(/has not passed/)
		checks = []
		policies = [{ expired: true, status: "approved" }]
		await expect(merge()).rejects.toThrow(/validations/)
		policies = []
		provider.prs[0].draft = true
		await expect(merge()).rejects.toThrow(/ready for review/)
		provider.prs[0].draft = false
		provider.mergeStates.set(12, "conflicts")
		await expect(merge()).rejects.toThrow(/merge cleanly/)
		provider.mergeStates.set(12, "clean")
		provider.prs[0].targetBranch = "other"
		await expect(merge()).rejects.toThrow(/target branch changed/)
		provider.prs[0].targetBranch = "main"
		Object.assign(provider, {
			prChecks: async () => {
				provider.prs[0].headSha = "b".repeat(40)
				return []
			},
		})
		await expect(merge()).rejects.toThrow(/changed while checking CI/)
		expect(merges).toBe(0)
		provider.prs[0].headSha = SHA_A
		Object.assign(provider, { prChecks: async () => [] })
		await merge()
		expect(merges).toBe(1)
	})

	it("rejects truncated run lists and concurrent merge requests", async () => {
		provider.runs.set(
			SHA_A,
			Array.from({ length: 100 }, (_, i) => boardRun(i + 1, "ci", "completed", "success")),
		)
		let release!: () => void
		let entered!: () => void
		const started = new Promise<void>((resolve) => {
			entered = resolve
		})
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		Object.assign(provider, {
			mergePr: async () => {
				entered()
				await pending
			},
		})
		const target = await board.addTarget({ kind: "pr", url: provider.prs[0].url })
		await board.refresh(target.id)
		const item = board.view()[0].items[0]
		const merge = () => board.runProviderAction(target.id, item.key, "merge-pr", "", 0, SHA_A, "main")
		await expect(merge()).rejects.toThrow(/Too many/)
		provider.runs.set(SHA_A, [boardRun(101, "ci", "completed", "success")])
		const first = merge()
		await started
		await expect(merge()).rejects.toThrow(/already/)
		release()
		await first
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

	it("requeues a failed run without a checkout and rejects stale selections", async () => {
		const reruns: [number, boolean][] = []
		Object.assign(provider, {
			rerunRun: async (id: number, failedOnly: boolean) => {
				reruns.push([id, failedOnly])
				return { url: "" }
			},
		})
		const target = await board.addTarget({ kind: "pr", url: provider.prs[0].url })
		await board.refresh(target.id)
		const item = board.view()[0].items[0]
		await expect(board.runProviderAction(target.id, item.key, "rerun-pipeline", "", 999)).rejects.toThrow(/changed/)
		await board.runProviderAction(target.id, item.key, "rerun-pipeline", "", 1)
		expect(reruns).toEqual([[1, false]])
		provider.runs.set(SHA_A, [boardRun(1, "ci", "in_progress")])
		await expect(board.runProviderAction(target.id, item.key, "rerun-pipeline", "", 1)).rejects.toThrow(/no longer failed/)
		provider.runs.set(SHA_A, [boardRun(1, "ci", "completed", "failure"), boardRun(2, "ci", "queued")])
		await expect(board.runProviderAction(target.id, item.key, "rerun-pipeline", "", 1)).rejects.toThrow(/newer run/)
		provider.prs[0].headSha = "b".repeat(40)
		await expect(board.runProviderAction(target.id, item.key, "rerun-pipeline", "", 1)).rejects.toThrow(/head changed/)
		provider.prs[0].state = "closed"
		await expect(board.runProviderAction(target.id, item.key, "rerun-pipeline", "", 1)).rejects.toThrow(/no longer open/)
		expect(reruns).toHaveLength(1)
	})

	it("requeues Azure DevOps validation through its policy and releases its lock after an error", async () => {
		provider = new FakeBoardProvider("Azure DevOps")
		provider.prs = [boardPr(12, { url: "https://dev.azure.com/acme/P/_git/r/pullrequest/12" })]
		provider.runs.set(SHA_A, [boardRun(1, "ci", "completed", "failure")])
		let status = "rejected"
		let fail = true
		let reruns = 0
		const requeued: string[] = []
		Object.assign(provider, {
			rerunRun: async () => {
				reruns++
				return { url: "" }
			},
			listBuildPolicies: async () => [{ evaluationId: "policy-1", name: "ci", buildId: 1, expired: false, status }],
			requeueBuildPolicy: async (id: string) => {
				if (fail) throw new Error("Service unavailable")
				requeued.push(id)
			},
		})
		const target = await board.addTarget({ kind: "pr", url: provider.prs[0].url })
		await board.refresh(target.id)
		const item = board.view()[0].items[0]
		await expect(board.runProviderAction(target.id, item.key, "rerun-pipeline", "", 1)).rejects.toThrow(/unavailable/)
		fail = false
		await board.runProviderAction(target.id, item.key, "rerun-pipeline", "", 1)
		expect(requeued).toEqual(["policy-1"])
		expect(reruns).toBe(0)
		status = "running"
		await expect(board.runProviderAction(target.id, item.key, "rerun-pipeline", "", 1)).rejects.toThrow(
			/already queued or running/,
		)
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
