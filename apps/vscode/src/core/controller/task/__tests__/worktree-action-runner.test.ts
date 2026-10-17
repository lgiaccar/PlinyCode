import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { HistoryItem, TaskWorktree } from "@shared/HistoryItem"
import type { Provider, PullRequest } from "@/services/devops-mcp/server/providers/types"
import type { RepoContext } from "@/services/devops-mcp/server/repo"
import { ensureTaskWorktree } from "@/services/git/worktrees"
import { removalPrompt, runWorktreeAction, type WorktreeActionDeps, worktreeCommitTitle } from "../worktree-action-runner"

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })
		.toString()
		.trim()
}

const GIT_TIMEOUT = 60_000

interface Fakes {
	deps: WorktreeActionDeps
	confirms: { message: string; detail: string; items: string[] }[]
	errors: string[]
	rows: string[]
	saved: TaskWorktree[]
	removedCalls: string[]
	created: unknown[][]
}

function fakes(item: HistoryItem | undefined, answer: (items: string[]) => string | undefined, running = false): Fakes {
	const f: Fakes = {
		confirms: [],
		errors: [],
		rows: [],
		saved: [],
		removedCalls: [],
		created: [],
		deps: undefined as unknown as WorktreeActionDeps,
	}
	const provider = {
		kind: "github",
		maxBodyLength: 1000,
		repoUrl: "https://github.com/o/r",
		defaultBranch: async () => "main",
		findOpenPr: async () => undefined,
		createPr: async (...args: unknown[]) => {
			f.created.push(args)
			return { id: 7, url: "https://github.com/o/r/pull/7" } as PullRequest
		},
	} as unknown as Provider
	f.deps = {
		getHistoryItem: async () => item,
		isRunning: () => running,
		confirm: async (message, detail, items) => {
			f.confirms.push({ message, detail, items })
			return answer(items)
		},
		showError: async (message) => {
			f.errors.push(message)
		},
		emitRow: (_taskId, text) => f.rows.push(text),
		setWorktree: async (_taskId, worktree) => {
			f.saved.push(worktree)
		},
		afterRemoved: async (taskId) => {
			f.removedCalls.push(taskId)
		},
		openRepo: async (cwd) => ({
			ctx: {
				root: cwd,
				remoteName: "origin",
				remote: { kind: "github", host: "github.com", owner: "o", repo: "r" },
			} as RepoContext,
			provider,
		}),
		now: () => 42,
	}
	return f
}

describe("worktree actions", () => {
	let dir: string
	let repo: string
	let worktree: TaskWorktree
	let item: HistoryItem

	beforeEach(async () => {
		dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wt-action-")))
		repo = path.join(dir, "repo")
		fs.mkdirSync(repo)
		git(repo, "init", "-q", "-b", "main")
		git(repo, "config", "user.name", "t")
		git(repo, "config", "user.email", "t@example.com")
		fs.writeFileSync(path.join(repo, "a.txt"), "a\n")
		git(repo, "add", "-A")
		git(repo, "commit", "-q", "-m", "init")
		const { notes: _notes, ...created } = await ensureTaskWorktree({ repoRoot: repo, title: "Fix the login page" })
		worktree = created
		item = { id: "task-1", task: "Fix the login page\nand more", ts: 1, tokensIn: 0, tokensOut: 0, totalCost: 0, worktree }
	}, GIT_TIMEOUT)

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it(
		"applies after confirmation and reports the staged files in a row",
		async () => {
			fs.writeFileSync(path.join(worktree.path, "a.txt"), "changed\n")
			const f = fakes(item, (items) => items[0])

			await runWorktreeAction(f.deps, "task-1", "apply")

			expect(f.errors).toEqual([])
			expect(f.confirms[0].items).toEqual(["Apply"])
			expect(git(repo, "diff", "--cached", "--name-only")).toBe("a.txt")
			expect(f.rows[0]).toContain("1 file(s) are staged")
		},
		GIT_TIMEOUT,
	)

	it(
		"does nothing when the modal is cancelled",
		async () => {
			fs.writeFileSync(path.join(worktree.path, "a.txt"), "changed\n")
			const f = fakes(item, () => undefined)

			await runWorktreeAction(f.deps, "task-1", "apply")

			expect(git(repo, "status", "--porcelain")).toBe("")
			expect(f.rows).toEqual([])
		},
		GIT_TIMEOUT,
	)

	it("refuses while the conversation runs, and for a conversation without a worktree", async () => {
		const running = fakes(item, (items) => items[0], true)
		await runWorktreeAction(running.deps, "task-1", "remove")
		expect(running.errors[0]).toContain("still running")
		expect(running.confirms).toEqual([])

		const plain = fakes({ ...item, worktree: undefined }, (items) => items[0])
		await runWorktreeAction(plain.deps, "task-1", "apply")
		expect(plain.errors[0]).toContain("does not run in a worktree")

		const removed = fakes({ ...item, worktree: { ...worktree, removedTs: 1 } }, (items) => items[0])
		await runWorktreeAction(removed.deps, "task-1", "create_pr")
		expect(removed.errors[0]).toContain("already removed")
	})

	it(
		"says so when the DevOps server does not work with the repository",
		async () => {
			const f = fakes(item, (items) => items[0])
			f.deps.openRepo = async () => {
				throw new Error("The repository has no remote named 'origin'.")
			}

			await runWorktreeAction(f.deps, "task-1", "create_pr")

			expect(f.errors[0]).toContain("DevOps server does not work with this repository")
			expect(f.errors[0]).toContain("no remote named 'origin'")
		},
		GIT_TIMEOUT,
	)

	it(
		"commits the uncommitted changes, pushes the branch and opens a draft pull request",
		async () => {
			const origin = path.join(dir, "origin.git")
			execFileSync("git", ["init", "-q", "--bare", origin], { stdio: "pipe" })
			git(repo, "remote", "add", "origin", origin)
			fs.writeFileSync(path.join(worktree.path, "b.txt"), "b\n")
			const f = fakes(item, (items) => items[0])

			await runWorktreeAction(f.deps, "task-1", "create_pr")

			expect(f.errors).toEqual([])
			expect(f.confirms[0].detail).toContain('committed as "Fix the login page"')
			expect(git(origin, "log", "-1", "--format=%s", worktree.branch)).toBe("Fix the login page")
			expect(f.created[0].slice(0, 1)).toEqual(["Fix the login page"])
			expect(f.created[0].slice(2)).toEqual([worktree.branch, "main", true])
			expect(String(f.created[0][1])).toContain("- Fix the login page")
			expect(f.rows[0]).toContain("https://github.com/o/r/pull/7")
		},
		GIT_TIMEOUT,
	)

	it(
		"refuses a pull request for a worktree without changes",
		async () => {
			const f = fakes(item, (items) => items[0])
			await runWorktreeAction(f.deps, "task-1", "create_pr")
			expect(f.errors[0]).toContain("nothing to propose")
			expect(f.confirms).toEqual([])
		},
		GIT_TIMEOUT,
	)

	it(
		"removes a dirty worktree only through the discard choice, then marks the conversation",
		async () => {
			fs.writeFileSync(path.join(worktree.path, "a.txt"), "dirty\n")
			const cancelled = fakes(item, () => undefined)
			await runWorktreeAction(cancelled.deps, "task-1", "remove")
			expect(fs.existsSync(worktree.path)).toBe(true)
			expect(cancelled.confirms[0].message).toContain("uncommitted change")
			// No commits of its own: the branch is merged, so it goes too.
			expect(cancelled.confirms[0].items).toEqual(["Discard and remove"])

			const f = fakes(item, (items) => items[0])
			await runWorktreeAction(f.deps, "task-1", "remove")

			expect(f.errors).toEqual([])
			expect(fs.existsSync(worktree.path)).toBe(false)
			expect(git(repo, "branch", "--list", worktree.branch)).toBe("")
			expect(f.saved).toEqual([{ ...worktree, removedTs: 42 }])
			expect(f.removedCalls).toEqual(["task-1"])
			expect(f.rows[0]).toContain("was deleted")
		},
		GIT_TIMEOUT,
	)

	it(
		"keeps an unmerged branch unless the user picks deleting it",
		async () => {
			fs.writeFileSync(path.join(worktree.path, "b.txt"), "b\n")
			git(worktree.path, "add", "-A")
			git(worktree.path, "commit", "-q", "-m", "work")
			const f = fakes(item, (items) => items.find((i) => i.endsWith("keep branch")))

			await runWorktreeAction(f.deps, "task-1", "remove")

			expect(f.confirms[0].items).toEqual(["Remove, keep branch", "Remove and delete branch"])
			expect(fs.existsSync(worktree.path)).toBe(false)
			expect(git(repo, "branch", "--list", worktree.branch)).toContain(worktree.branch)
			expect(f.rows[0]).toContain("is kept")
		},
		GIT_TIMEOUT,
	)
})

describe("worktree action helpers", () => {
	it("makes a one-line commit title from the conversation title", () => {
		expect(worktreeCommitTitle("  Fix it\nmore", "plinycode/x")).toBe("Fix it")
		expect(worktreeCommitTitle("", "plinycode/x")).toBe("Changes from plinycode/x")
		expect(worktreeCommitTitle("x".repeat(100), "b").length).toBe(72)
	})

	it("offers a forget-only removal for a folder that is gone", () => {
		const worktree = { repoRoot: "/r", branch: "plinycode/x", path: "/r.worktrees/x" }
		const state = { exists: false, dirty: [], merged: true, unmerged: 0, into: "main" }
		const prompt = removalPrompt(worktree, state, { note: "Gone." })
		expect(prompt.message).toContain("already gone")
		expect(prompt.choices).toEqual({ Remove: { force: false, deleteBranch: true } })
	})

	it("never offers to delete a CI Board worktree's branch", () => {
		const worktree = { repoRoot: "/r", branch: "feature/x", path: "/r.worktrees/feature-x" }
		const state = { exists: true, dirty: ["a.txt"], merged: false, unmerged: 3, into: "main" }
		const prompt = removalPrompt(worktree, state, { note: "CI.", keepBranch: true })
		expect(prompt.choices).toEqual({ "Discard and remove": { force: true, deleteBranch: false } })
		expect(prompt.detail).toBe("CI. The branch feature/x is kept.")
	})
})
