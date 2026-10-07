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
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ci-board-")))
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
		expect([a.kind, a.prId, a.provider, a.autonomy, a.actions.map((x) => x.id)]).toEqual([
			"pr",
			12,
			"github",
			"manual",
			["fix"],
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
		await board.updateTarget(t.id, { autonomy: "auto" })
		expect(board.target(t.id)?.autonomy).toBe("auto")
		await board.setLink("k", { conversationId: "c1", actionId: "fix", worktree: "/w", startedTs: 1 })
		expect(board.linkFor("k")?.conversationId).toBe("c1")
		await board.removeTarget(t.id)
		expect(board.view()).toEqual([])
		await expect(board.updateTarget(t.id, {})).rejects.toThrow(/no longer exists/)
	})

	it("blocks runs without a checkout, on forks and on closed PRs", async () => {
		const t = await board.addTarget({ kind: "pr", url: "https://github.com/octo/hello/pull/12" })
		await board.refresh()
		const [item] = board.view()[0].items
		expect(board.runBlockedReason(t, item)).toContain("No folder open in this window")
		await expect(board.prepareRun(t.id, item.key, "fix")).rejects.toThrow(/No folder open/)
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
		const run = await board.prepareRun(t.id, item.key, "fix")
		expect(run.worktree.created).toBe(true)
		expect(run.worktree.path).toBe(path.join(dir, "worktrees", "repo", "feature"))
		expect(run.prompt.startsWith(`${CI_BOARD_MARKER} PR #12`)).toBe(true)
		expect(run.prompt).toContain("- ✗ ci: failure (run 1)")
		expect(run.prompt).toContain("Get this pull request green")
	}, 30_000)
})
