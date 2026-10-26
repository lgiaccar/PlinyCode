import { execFile } from "node:child_process"
import { promises as fs, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { arePathsEqual } from "@/utils/path"
import { loadContext } from "../repo"

const dirs: string[] = []

async function git(cwd: string, args: string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		execFile("git", ["-C", cwd, ...args], { windowsHide: true }, (error) => {
			if (error) reject(error)
			else resolve()
		})
	})
}

async function initRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "pliny-repo-"))
	dirs.push(dir)
	await git(dir, ["init"])
	await git(dir, ["config", "user.email", "test@example.com"])
	await git(dir, ["config", "user.name", "Test"])
	await fs.writeFile(path.join(dir, "README.md"), "hi\n")
	await git(dir, ["add", "README.md"])
	await git(dir, ["commit", "-m", "init"])
	await git(dir, ["remote", "add", "origin", "https://github.com/org/repo.git"])
	return dir
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

describe("loadContext", () => {
	it("finds a repository when .git is hidden on Windows", async () => {
		const root = await initRepo()
		if (process.platform === "win32") {
			await new Promise<void>((resolve, reject) => {
				execFile("attrib", ["+h", ".git"], { cwd: root, windowsHide: true }, (error) => {
					if (error) reject(error)
					else resolve()
				})
			})
		}
		const ctx = await loadContext(root)
		const canonical = (value: string) => {
			try {
				return realpathSync(value)
			} catch {
				return value
			}
		}
		expect(arePathsEqual(canonical(ctx.root), canonical(root))).toBe(true)
	})
})
