import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
	ensureTaskWorktree,
	ensureWorktree,
	listWorktrees,
	removeWorktree,
	taskBranchSlug,
	worktreeRoot,
	worktreeSlug,
} from "../worktrees"

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
		stdio: "pipe",
	})
		.toString()
		.trim()
}

describe("worktreeSlug", () => {
	it("keeps simple names and shortens or cleans the rest with a hash", () => {
		expect(worktreeSlug("feature-1")).toBe("feature-1")
		expect(worktreeSlug("lgiaccar/fix")).toMatch(/^lgiaccar-fix-[0-9a-f]{8}$/)
		expect(worktreeSlug("lgiaccar-fix")).not.toBe(worktreeSlug("lgiaccar/fix"))
		expect(worktreeSlug("x".repeat(80)).length).toBe(49)
	})

	it("puts worktrees next to the repository unless a folder is set", () => {
		expect(worktreeRoot(path.join("/src", "repo"))).toBe(path.join("/src", "repo.worktrees"))
		expect(worktreeRoot(path.join("/src", "repo"), "/wt")).toBe(path.join("/wt", "repo"))
	})
})

const GIT_TIMEOUT = 30_000

describe("ensureWorktree", () => {
	let dir: string
	let origin: string
	let repo: string
	let root: string

	beforeEach(() => {
		dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ci-wt-")))
		origin = path.join(dir, "origin")
		repo = path.join(dir, "repo")
		root = path.join(dir, "repo.worktrees")
		fs.mkdirSync(origin)
		git(origin, "init", "-q", "-b", "main")
		git(origin, "commit", "-q", "--allow-empty", "-m", "init")
		git(origin, "branch", "feature/x")
		execFileSync("git", ["clone", "-q", origin, repo], { stdio: "pipe" })
	})

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	const ensure = (branch: string) => ensureWorktree({ repoRoot: repo, remoteName: "origin", branch, root })

	it(
		"works in the repository itself when the branch is checked out there",
		async () => {
			const result = await ensure("main")
			expect([result.path, result.inPlace, result.created]).toEqual([repo, true, false])
			expect(result.notes[0]).toContain("checked out")
		},
		GIT_TIMEOUT,
	)

	it(
		"creates a tracking worktree from the remote branch, then reuses it",
		async () => {
			const first = await ensure("feature/x")
			expect([first.inPlace, first.created]).toEqual([false, true])
			expect(path.dirname(first.path)).toBe(root)
			expect(git(first.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/x")
			expect(git(first.path, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feature/x")

			// A push from elsewhere: the clean worktree is fast-forwarded.
			git(origin, "checkout", "-q", "feature/x")
			git(origin, "commit", "-q", "--allow-empty", "-m", "more")
			const second = await ensure("feature/x")
			expect([second.path, second.created, second.notes]).toEqual([first.path, false, []])
			expect(git(second.path, "rev-parse", "HEAD")).toBe(git(origin, "rev-parse", "HEAD"))
			expect((await listWorktrees(repo)).map((w) => w.branch)).toEqual(["main", "feature/x"])
		},
		GIT_TIMEOUT,
	)

	it(
		"leaves a worktree with local changes as it is, and says so",
		async () => {
			const { path: wt } = await ensure("feature/x")
			fs.writeFileSync(path.join(wt, "draft.txt"), "wip")
			git(origin, "commit", "-q", "--allow-empty", "-m", "more")
			const again = await ensure("feature/x")
			expect(again.notes[0]).toContain("uncommitted changes")
			await expect(removeWorktree(repo, wt)).rejects.toThrow(/uncommitted changes/)
			fs.rmSync(path.join(wt, "draft.txt"))
			await removeWorktree(repo, wt)
			expect(fs.existsSync(wt)).toBe(false)
		},
		GIT_TIMEOUT,
	)

	it(
		"says when the branch does not exist on the remote",
		async () => {
			await expect(ensure("nope")).rejects.toThrow(/Could not fetch 'nope'/)
		},
		GIT_TIMEOUT,
	)
})

describe("taskBranchSlug", () => {
	it("makes short lowercase ASCII words of a title", () => {
		expect(taskBranchSlug("Fix the login page!")).toBe("fix-the-login-page")
		expect(taskBranchSlug("  Café: résumé  ")).toBe("cafe-resume")
		expect(taskBranchSlug("???")).toBe("task")
		const long = taskBranchSlug("Refactor the payment gateway adapter so retries are idempotent")
		expect(long.length).toBeLessThanOrEqual(40)
		expect(long).toBe("refactor-the-payment-gateway-adapter-so")
	})
})

describe("ensureTaskWorktree", () => {
	let dir: string
	let repo: string

	beforeEach(() => {
		dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "task-wt-")))
		repo = path.join(dir, "repo")
		fs.mkdirSync(path.join(repo, "sub"), { recursive: true })
		git(repo, "init", "-q", "-b", "main")
		fs.writeFileSync(path.join(repo, "sub", "a.txt"), "a")
		git(repo, "add", ".")
		git(repo, "commit", "-q", "-m", "init")
	})

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it(
		"branches from HEAD into a folder next to the repository",
		async () => {
			const result = await ensureTaskWorktree({ repoRoot: path.join(repo, "sub"), title: "Fix the login page" })
			expect(result.repoRoot).toBe(repo)
			expect(result.branch).toMatch(/^plinycode\/fix-the-login-page-[0-9a-f]{4}$/)
			expect(path.dirname(result.path)).toBe(path.join(dir, "repo.worktrees"))
			expect(path.basename(result.path)).toBe(`fix-the-login-page-${result.branch.slice(-4)}`)
			expect(git(result.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(result.branch)
			expect(git(result.path, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"))
			expect(fs.existsSync(path.join(result.path, "sub", "a.txt"))).toBe(true)
			expect(result.notes).toEqual([])
			// The user's checkout stays on its branch.
			expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
		},
		GIT_TIMEOUT,
	)

	it(
		"uses the configured folder, and says that uncommitted changes stay behind",
		async () => {
			fs.writeFileSync(path.join(repo, "draft.txt"), "wip")
			const root = path.join(dir, "wt")
			const result = await ensureTaskWorktree({ repoRoot: repo, title: "x", configuredRoot: root })
			expect(path.dirname(result.path)).toBe(path.join(root, "repo"))
			expect(result.branch).toMatch(/^plinycode\/x-[0-9a-f]{4}$/)
			expect(fs.existsSync(path.join(result.path, "draft.txt"))).toBe(false)
			expect(result.notes[0]).toContain("uncommitted changes")
		},
		GIT_TIMEOUT,
	)

	it(
		"puts a worktree started from another worktree next to the main checkout",
		async () => {
			const first = await ensureTaskWorktree({ repoRoot: repo, title: "first" })
			const second = await ensureTaskWorktree({ repoRoot: first.path, title: "second" })
			expect(second.repoRoot).toBe(first.path)
			expect(path.dirname(second.path)).toBe(path.join(dir, "repo.worktrees"))
			expect(second.branch).not.toBe(first.branch)
		},
		GIT_TIMEOUT,
	)

	it(
		"refuses a folder outside a repository and a repository without commits",
		async () => {
			const plain = path.join(dir, "plain")
			fs.mkdirSync(plain)
			await expect(ensureTaskWorktree({ repoRoot: plain, title: "x" })).rejects.toThrow(/not in a git repository/)
			const empty = path.join(dir, "empty")
			fs.mkdirSync(empty)
			git(empty, "init", "-q")
			await expect(ensureTaskWorktree({ repoRoot: empty, title: "x" })).rejects.toThrow(/no commit yet/)
		},
		GIT_TIMEOUT,
	)
})
