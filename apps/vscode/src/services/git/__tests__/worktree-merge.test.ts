import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { TaskWorktree } from "@shared/HistoryItem"
import {
	applyWorktreeToSource,
	branchMergeState,
	changedPaths,
	commitAll,
	pushBranch,
	removeTaskWorktree,
	WorktreeActionError,
	worktreeBase,
} from "../worktree-merge"
import { ensureTaskWorktree } from "../worktrees"

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })
		.toString()
		.trim()
}

const write = (dir: string, file: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
	fs.writeFileSync(path.join(dir, file), text)
}
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8").replace(/\r\n/g, "\n")
const staged = (dir: string) => git(dir, "diff", "--cached", "--name-only").split(/\r?\n/).filter(Boolean).sort()

const GIT_TIMEOUT = 60_000

async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise
	} catch (error) {
		return error as Error
	}
	throw new Error("expected a rejection")
}

describe("worktree merge-back", () => {
	let dir: string
	let repo: string
	let worktree: TaskWorktree

	beforeEach(async () => {
		dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wt-merge-")))
		repo = path.join(dir, "repo")
		fs.mkdirSync(repo)
		git(repo, "init", "-q", "-b", "main")
		git(repo, "config", "user.name", "t")
		git(repo, "config", "user.email", "t@example.com")
		git(repo, "config", "core.autocrlf", "false")
		write(repo, "a.txt", "a\nb\nc\n")
		write(repo, "b.txt", "one\n")
		git(repo, "add", "-A")
		git(repo, "commit", "-q", "-m", "init")
		const { notes: _notes, ...created } = await ensureTaskWorktree({ repoRoot: repo, title: "Change things" })
		worktree = created
	}, GIT_TIMEOUT)

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	/** A commit on the worktree branch, an unstaged edit and a new file. */
	const workInWorktree = () => {
		write(worktree.path, "a.txt", "a\nB\nc\n")
		git(worktree.path, "commit", "-q", "-am", "change a")
		write(worktree.path, "b.txt", "two\n")
		write(worktree.path, "new/c.txt", "new\n")
	}

	it("records the base commit when the worktree is created", () => {
		expect(worktree.baseCommit).toBe(git(repo, "rev-parse", "HEAD"))
	})

	it(
		"applies committed and uncommitted changes to the source checkout, staged and not committed",
		async () => {
			workInWorktree()
			const head = git(repo, "rev-parse", "HEAD")

			const result = await applyWorktreeToSource(worktree)

			expect(result.files.sort()).toEqual(["a.txt", "b.txt", "new/c.txt"])
			expect(staged(repo)).toEqual(["a.txt", "b.txt", "new/c.txt"])
			expect(read(repo, "a.txt")).toBe("a\nB\nc\n")
			expect(read(repo, "new/c.txt")).toBe("new\n")
			expect(git(repo, "rev-parse", "HEAD")).toBe(head)
			// The worktree itself is left as it was.
			expect((await changedPaths(worktree.path)).sort()).toEqual(["b.txt", "new/c.txt"])
		},
		GIT_TIMEOUT,
	)

	it(
		"falls back to the merge base when no base commit was recorded",
		async () => {
			workInWorktree()
			const { baseCommit: _base, ...old } = worktree
			expect(await worktreeBase(old)).toBe(git(repo, "rev-parse", "HEAD"))
			expect((await applyWorktreeToSource(old)).files.length).toBe(3)
		},
		GIT_TIMEOUT,
	)

	it(
		"refuses when the source checkout has uncommitted changes to the same paths",
		async () => {
			workInWorktree()
			write(repo, "a.txt", "local\n")

			const error = await rejection(applyWorktreeToSource(worktree))

			expect(error).toBeInstanceOf(WorktreeActionError)
			expect(error.message).toContain("a.txt")
			expect(read(repo, "a.txt")).toBe("local\n")
			expect(staged(repo)).toEqual([])
		},
		GIT_TIMEOUT,
	)

	it(
		"applies beside unrelated local changes",
		async () => {
			workInWorktree()
			write(repo, "other.txt", "mine\n")

			await applyWorktreeToSource(worktree)

			expect(staged(repo)).toEqual(["a.txt", "b.txt", "new/c.txt"])
			expect(read(repo, "other.txt")).toBe("mine\n")
		},
		GIT_TIMEOUT,
	)

	it(
		"leaves the source checkout untouched when the changes would conflict",
		async () => {
			workInWorktree()
			write(repo, "a.txt", "a\nZ\nc\n")
			git(repo, "commit", "-q", "-am", "conflicting")

			const error = await rejection(applyWorktreeToSource(worktree))

			expect(error).toBeInstanceOf(WorktreeActionError)
			expect(error.message).toContain("a.txt")
			expect(git(repo, "status", "--porcelain")).toBe("")
			expect(read(repo, "a.txt")).toBe("a\nZ\nc\n")
		},
		GIT_TIMEOUT,
	)

	it(
		"merges with three-way apply when the source moved on elsewhere in the file",
		async () => {
			workInWorktree()
			write(repo, "a.txt", "a\nb\nc\nd\n")
			git(repo, "commit", "-q", "-am", "append")

			await applyWorktreeToSource(worktree)

			expect(read(repo, "a.txt")).toBe("a\nB\nc\nd\n")
		},
		GIT_TIMEOUT,
	)

	it(
		"says there is nothing to apply for an untouched worktree",
		async () => {
			const error = await rejection(applyWorktreeToSource(worktree))
			expect(error.message).toContain("nothing to apply")
		},
		GIT_TIMEOUT,
	)

	it(
		"refuses to remove a dirty worktree unless forced, and deletes the branch only when asked",
		async () => {
			write(worktree.path, "b.txt", "dirty\n")

			const error = await rejection(removeTaskWorktree(worktree))
			expect(error.message).toContain("uncommitted changes")
			expect(fs.existsSync(worktree.path)).toBe(true)

			const result = await removeTaskWorktree(worktree, { force: true })
			expect(result.branchDeleted).toBe(false)
			expect(fs.existsSync(worktree.path)).toBe(false)
			expect(git(repo, "branch", "--list", worktree.branch)).toContain(worktree.branch)

			expect((await removeTaskWorktree(worktree, { deleteBranch: true })).branchDeleted).toBe(true)
			expect(git(repo, "branch", "--list", worktree.branch)).toBe("")
		},
		GIT_TIMEOUT,
	)

	it(
		"tells merged branches from unmerged ones",
		async () => {
			expect((await branchMergeState(repo, worktree.branch)).merged).toBe(true)
			workInWorktree()
			const state = await branchMergeState(repo, worktree.branch)
			expect([state.merged, state.unmerged, state.into]).toEqual([false, 1, "main"])
			expect((await branchMergeState(repo, "plinycode/gone")).missing).toBe(true)
		},
		GIT_TIMEOUT,
	)

	it(
		"commits everything and pushes the branch",
		async () => {
			const origin = path.join(dir, "origin.git")
			execFileSync("git", ["init", "-q", "--bare", origin], { stdio: "pipe" })
			git(repo, "remote", "add", "origin", origin)
			workInWorktree()

			expect(await commitAll(worktree.path, "Change things")).toBe(true)
			expect(await commitAll(worktree.path, "again")).toBe(false)
			await pushBranch(worktree.path, "origin", worktree.branch)

			expect(git(origin, "log", "-1", "--format=%s", worktree.branch)).toBe("Change things")
			expect(git(worktree.path, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(`origin/${worktree.branch}`)
		},
		GIT_TIMEOUT,
	)
})
