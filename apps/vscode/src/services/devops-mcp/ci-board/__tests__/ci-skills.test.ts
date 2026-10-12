import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { detectCiSkills } from "../ci-skills"

describe("detectCiSkills", () => {
	let root: string

	const skill = (dir: string, name: string, frontmatterName?: string) => {
		const folder = path.join(root, dir, name)
		fs.mkdirSync(folder, { recursive: true })
		fs.writeFileSync(
			path.join(folder, "SKILL.md"),
			frontmatterName ? `---\nname: ${frontmatterName}\ndescription: x\n---\n# Skill\n` : "# Skill\n",
		)
	}

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-skills-"))
	})

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true })
	})

	it("matches a repository's skills to the built-in actions by name", async () => {
		skill(".github/skills", "fix-conflicts", "fix-conflicts")
		skill(".github/skills", "recalibrate-unit-tests")
		skill(".github/skills", "analyze-pipeline-deltas", "analyze-pipeline-deltas")
		skill(".github/skills", "write-docs")
		fs.mkdirSync(path.join(root, ".claude", "skills", "empty-folder"), { recursive: true })
		fs.writeFileSync(path.join(root, ".claude", "skills", "golden-files.md"), "# flat skill\n")

		const skills = await detectCiSkills(root, 1)
		expect(skills["fix-conflicts"].map((s) => s.name)).toEqual(["fix-conflicts"])
		expect(skills.recalibrate.map((s) => s.name).sort()).toEqual(["golden-files", "recalibrate-unit-tests"])
		expect(skills["fix-ci"].map((s) => s.name)).toEqual(["analyze-pipeline-deltas"])
		expect(skills.investigate.map((s) => s.name)).toEqual(["analyze-pipeline-deltas"])
		expect(skills.recalibrate.find((s) => s.name === "recalibrate-unit-tests")?.path).toBe(
			path.join(root, ".github", "skills", "recalibrate-unit-tests", "SKILL.md"),
		)
	})
})
