import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ensureReportDir } from "../report-dir"

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
		stdio: "pipe",
	}).toString()

describe("ensureReportDir", () => {
	let dir: string
	let repo: string

	beforeEach(() => {
		dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "report-dir-")))
		repo = path.join(dir, "repo")
		fs.mkdirSync(repo)
		git(repo, "init", "-q", "-b", "main")
		git(repo, "commit", "-q", "--allow-empty", "-m", "init")
	})

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it("ignores the report folder through the shared exclude file, once, from a worktree too", async () => {
		const worktree = path.join(dir, "wt")
		git(repo, "worktree", "add", "-q", "-b", "feature", worktree)

		const reports = await ensureReportDir(worktree)
		expect(reports).toBe(path.join(worktree, ".plinycode", "ci-reports"))
		fs.writeFileSync(path.join(reports, "pr-1.md"), "# report")
		await ensureReportDir(repo)
		await ensureReportDir(repo)

		const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8")
		expect(exclude.split("\n").filter((line) => line === "/.plinycode/")).toHaveLength(1)
		expect(git(worktree, "status", "--porcelain")).toBe("")
		expect(fs.existsSync(path.join(repo, ".gitignore"))).toBe(false)
	}, 30_000)
})
