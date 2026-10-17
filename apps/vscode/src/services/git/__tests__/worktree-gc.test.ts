import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { TaskWorktree } from "@shared/HistoryItem"
import {
	type CiWorktreeLink,
	collectWorktreeGarbage,
	gcVerdict,
	type PlinyWorktree,
	type WorktreeConversation,
} from "../worktree-gc"
import { ensureTaskWorktree } from "../worktrees"

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })
		.toString()
		.trim()
}

const DAY = 24 * 60 * 60 * 1000
const GIT_TIMEOUT = 90_000

describe("gcVerdict", () => {
	const now = 100 * DAY
	const base: PlinyWorktree = {
		repoRoot: "/repo",
		path: "/repo.worktrees/x",
		branch: "plinycode/x-ab12",
		kind: "conversation",
		conversationIds: ["c1"],
		lastActivityTs: now - 8 * DAY,
		dirty: false,
		createdTs: now - 30 * DAY,
	}
	const context = { now, keepDays: 7, isActive: () => false, openFolders: [] as string[] }

	it("removes idle and orphaned worktrees, and keeps the rest", () => {
		expect(gcVerdict(base, context).remove).toBe(true)
		expect(gcVerdict({ ...base, conversationIds: [] }, context)).toEqual({
			remove: true,
			reason: "its conversation was deleted",
		})
		expect(gcVerdict({ ...base, lastActivityTs: now - 2 * DAY }, context).remove).toBe(false)
		expect(gcVerdict({ ...base, dirty: true }, context).reason).toContain("uncommitted")
		expect(gcVerdict(base, { ...context, keepDays: 0 }).remove).toBe(false)
		expect(gcVerdict(base, { ...context, isActive: (id) => id === "c1" }).reason).toContain("running")
		expect(gcVerdict(base, { ...context, openFolders: [path.join(base.path, "sub")] }).reason).toContain("open")
		expect(gcVerdict({ ...base, conversationIds: [], createdTs: now - 1000 }, context).remove).toBe(false)
	})
})

describe("collectWorktreeGarbage", () => {
	let dir: string
	let repo: string
	let wtRoot: string
	const logs: string[] = []

	beforeEach(() => {
		dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wt-gc-")))
		repo = path.join(dir, "repo")
		wtRoot = path.join(dir, "repo.worktrees")
		fs.mkdirSync(repo)
		git(repo, "init", "-q", "-b", "main")
		git(repo, "config", "user.name", "t")
		git(repo, "config", "user.email", "t@example.com")
		fs.writeFileSync(path.join(repo, "a.txt"), "a\n")
		git(repo, "add", "-A")
		git(repo, "commit", "-q", "-m", "init")
		logs.length = 0
	})

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	const taskWorktree = async (title: string): Promise<TaskWorktree> => {
		const { notes: _notes, ...created } = await ensureTaskWorktree({ repoRoot: repo, title })
		return created
	}

	/** Runs a pass two hours from now, so the fresh worktrees are past the minimum age. */
	const run = (conversations: WorktreeConversation[], ciLinks: CiWorktreeLink[] = [], keepDays = 7) => {
		const removed: string[] = []
		return collectWorktreeGarbage({
			keepDays,
			now: () => Date.now() + 2 * 60 * 60 * 1000,
			isActive: () => false,
			openFolders: [],
			scan: async () => ({ conversations, ciLinks, configuredRoots: [] }),
			log: (message) => logs.push(message),
			onRemoved: async (worktree) => {
				removed.push(worktree.path)
			},
		}).then((outcomes) => ({ outcomes, removed }))
	}

	it(
		"removes clean worktrees of deleted or idle conversations and keeps dirty, recent and foreign ones",
		async () => {
			const orphan = await taskWorktree("orphan")
			const idle = await taskWorktree("idle")
			const recent = await taskWorktree("recent")
			const dirty = await taskWorktree("dirty")
			fs.writeFileSync(path.join(dirty.path, "a.txt"), "changed\n")
			// A worktree the user made in the same folder, on a branch of their own.
			const foreign = path.join(wtRoot, "mine")
			git(repo, "worktree", "add", "-q", "-b", "mine", foreign)
			const now = Date.now()
			const conversations: WorktreeConversation[] = [
				{ id: "idle", ts: now - 10 * DAY, worktree: idle },
				{ id: "recent", ts: now - DAY, worktree: recent },
				{ id: "dirty", ts: now - 30 * DAY, worktree: dirty },
				// Another conversation of the same repository leads the scan to it.
				{ id: "orphan-source", ts: now, worktree: { ...orphan, path: path.join(dir, "gone") } },
			]

			const { outcomes, removed } = await run(conversations)

			expect(removed.sort()).toEqual([idle.path, orphan.path].sort())
			expect(fs.existsSync(orphan.path)).toBe(false)
			expect(fs.existsSync(idle.path)).toBe(false)
			expect(fs.existsSync(recent.path)).toBe(true)
			expect(fs.existsSync(dirty.path)).toBe(true)
			expect(fs.existsSync(foreign)).toBe(true)
			expect(outcomes.some((o) => o.worktree.path === foreign)).toBe(false)
			// Their branches had no commits of their own, so they were merged and went too.
			expect(git(repo, "branch", "--list", idle.branch)).toBe("")
			expect(git(repo, "branch", "--list", recent.branch)).toContain(recent.branch)
			expect(logs.join("\n")).toContain("its conversation was deleted")
		},
		GIT_TIMEOUT,
	)

	it(
		"keeps an unmerged plinycode branch after removing its worktree",
		async () => {
			const wt = await taskWorktree("work")
			fs.writeFileSync(path.join(wt.path, "b.txt"), "b\n")
			git(wt.path, "add", "-A")
			git(wt.path, "commit", "-q", "-m", "work")

			await run([{ id: "work", ts: Date.now() - 10 * DAY, worktree: wt }])

			expect(fs.existsSync(wt.path)).toBe(false)
			expect(git(repo, "branch", "--list", wt.branch)).toContain(wt.branch)
		},
		GIT_TIMEOUT,
	)

	it(
		"removes a CI Board worktree whose conversation was deleted, keeping its branch",
		async () => {
			const ci = path.join(wtRoot, "feature-x")
			git(repo, "worktree", "add", "-q", "-b", "feature/x", ci)

			const { removed } = await run([], [{ conversationId: "gone", worktree: ci, startedTs: Date.now() - DAY }])

			expect(removed).toEqual([ci])
			expect(git(repo, "branch", "--list", "feature/x")).toContain("feature/x")
		},
		GIT_TIMEOUT,
	)

	it(
		"does nothing when keepDays is 0",
		async () => {
			const wt = await taskWorktree("kept")
			const { outcomes } = await run([{ id: "kept", ts: 0, worktree: wt }], [], 0)
			expect(outcomes).toEqual([])
			expect(fs.existsSync(wt.path)).toBe(true)
		},
		GIT_TIMEOUT,
	)
})
