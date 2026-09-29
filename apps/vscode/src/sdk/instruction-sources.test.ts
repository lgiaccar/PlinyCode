import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ClineRulesToggles } from "@shared/cline-rules"
import { afterEach, describe, expect, it } from "vitest"
import { detectInstructionEditor, migrateDeprecatedGlobalRules } from "./instruction-sources"

describe("detectInstructionEditor", () => {
	it("maps editor app names", () => {
		expect(detectInstructionEditor("Cursor")).toBe("cursor")
		expect(detectInstructionEditor("Windsurf")).toBe("windsurf")
		expect(detectInstructionEditor("Visual Studio Code")).toBe("vscode")
		expect(detectInstructionEditor("Visual Studio Code - Insiders")).toBe("vscode")
		expect(detectInstructionEditor("VSCodium")).toBe("vscode")
	})
})

describe("migrateDeprecatedGlobalRules", () => {
	let root: string | undefined

	afterEach(() => {
		if (root) {
			rmSync(root, { recursive: true, force: true })
			root = undefined
		}
	})

	function setup() {
		root = mkdtempSync(path.join(tmpdir(), "plinycode-rules-"))
		const from = path.join(root, ".cline", "rules")
		const to = path.join(root, "Documents", "Cline", "Rules")
		mkdirSync(from, { recursive: true })
		mkdirSync(to, { recursive: true })
		return { from, to }
	}

	it("moves rule files and carries their toggles", async () => {
		const { from, to } = setup()
		writeFileSync(path.join(from, "style.md"), "use tabs")
		writeFileSync(path.join(from, "clash.md"), "old copy")
		writeFileSync(path.join(to, "clash.md"), "kept")
		let toggles: ClineRulesToggles = { [path.join(from, "style.md")]: false }

		const result = await migrateDeprecatedGlobalRules({
			from,
			to,
			getGlobalToggles: () => toggles,
			setGlobalToggles: (next) => {
				toggles = next
			},
		})

		expect(result.moved).toEqual([path.join(to, "style.md")])
		expect(result.skipped).toEqual([path.join(from, "clash.md")])
		expect(readFileSync(path.join(to, "style.md"), "utf8")).toBe("use tabs")
		expect(readFileSync(path.join(to, "clash.md"), "utf8")).toBe("kept")
		expect(toggles).toEqual({ [path.join(to, "style.md")]: false })
	})

	it("does nothing when the old folder is missing", async () => {
		const { to } = setup()
		const result = await migrateDeprecatedGlobalRules({
			from: path.join(to, "does-not-exist"),
			to,
			getGlobalToggles: () => ({}),
			setGlobalToggles: () => {
				throw new Error("should not write toggles")
			},
		})
		expect(result).toEqual({ moved: [], skipped: [] })
	})
})
