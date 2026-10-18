import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { listSavedPlans, workspacePlanFolder } from "./plan-folder"

describe("workspacePlanFolder", () => {
	it("gives each workspace a folder of its own, named after it", () => {
		const root = path.join(os.tmpdir(), "plans")
		const folder = workspacePlanFolder(path.join(os.tmpdir(), "My Repo"), root)
		expect(path.dirname(folder)).toBe(root)
		expect(path.basename(folder)).toMatch(/^my-repo-[0-9a-f]{8}$/)
		expect(workspacePlanFolder(path.join(os.tmpdir(), "My Repo"), root)).toBe(folder)
		expect(workspacePlanFolder(path.join(os.tmpdir(), "other", "My Repo"), root)).not.toBe(folder)
	})

	it.if(process.platform === "win32")("ignores the case of a Windows path", () => {
		expect(workspacePlanFolder("C:\\Dev\\Repo", "D:\\plans")).toBe(workspacePlanFolder("c:\\dev\\repo", "D:\\plans"))
	})
})

describe("listSavedPlans", () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "plan-folder-"))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it("lists each plan's root file, newest first", async () => {
		await mkdir(path.join(dir, "old"))
		await writeFile(path.join(dir, "old", "PLAN.md"), "# old")
		await utimes(path.join(dir, "old", "PLAN.md"), new Date(1000), new Date(1000))
		await mkdir(path.join(dir, "new"))
		await writeFile(path.join(dir, "new", "01-backend.md"), "# part")
		await writeFile(path.join(dir, "new", "PLAN.md"), "# new")
		await mkdir(path.join(dir, "loose"))
		await writeFile(path.join(dir, "loose", "notes.md"), "# notes")
		await utimes(path.join(dir, "loose", "notes.md"), new Date(2000), new Date(2000))
		await mkdir(path.join(dir, "empty"))

		const plans = await listSavedPlans(dir)

		expect(plans.map((plan) => [plan.slug, path.basename(plan.file)])).toEqual([
			["new", "PLAN.md"],
			["loose", "notes.md"],
			["old", "PLAN.md"],
		])
	})

	it("is empty for a workspace without plans", async () => {
		expect(await listSavedPlans(path.join(dir, "missing"))).toEqual([])
	})
})
