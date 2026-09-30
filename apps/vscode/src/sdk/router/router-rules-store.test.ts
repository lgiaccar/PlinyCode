import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { extractYamlBlock, parseRulesMarkdown } from "./router-rules"
import { initialiseDefaultRulesFile, isUntouchedSeed, renderDefaultRulesMarkdown, seedMarker } from "./router-rules-store"

const tempDirs: string[] = []

async function tempDataDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pliny-rules-"))
	tempDirs.push(dir)
	return dir
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("rules file seed marker", () => {
	it("marks a rendered file as an untouched seed until its yaml is edited", () => {
		const seed = renderDefaultRulesMarkdown()
		expect(seed.startsWith(seedMarker(seed))).toBe(true)
		expect(isUntouchedSeed(seed)).toBe(true)
		expect(isUntouchedSeed(seed.replace("sticky: true", "sticky: false"))).toBe(false)
		// A file written before markers existed is treated as the user's.
		expect(isUntouchedSeed(seed.replace(/^<!--.*-->\n/, ""))).toBe(false)
	})

	it("keeps the marker out of the classifier guidance", () => {
		expect(parseRulesMarkdown(renderDefaultRulesMarkdown("smart"), "smart").guidance).not.toContain("plinycode-defaults")
	})

	it("creates a missing file and leaves an up-to-date or edited one alone", async () => {
		const dataDir = await tempDataDir()
		const filePath = await initialiseDefaultRulesFile(dataDir, "fast")
		expect(filePath).toBeDefined()
		const seed = await fs.readFile(filePath ?? "", "utf8")
		expect(seed).toBe(renderDefaultRulesMarkdown("fast"))

		// Unchanged defaults: nothing happens.
		await initialiseDefaultRulesFile(dataDir, "fast")
		expect(await fs.readFile(filePath ?? "", "utf8")).toBe(seed)

		// Edited: kept as is, no backup written.
		const edited = seed.replace("sticky: true", "sticky: false")
		await fs.writeFile(filePath ?? "", edited, "utf8")
		await initialiseDefaultRulesFile(dataDir, "fast")
		expect(await fs.readFile(filePath ?? "", "utf8")).toBe(edited)
		await expect(fs.access(`${filePath}.bak`)).rejects.toThrow()
	})

	it("replaces an untouched seed of older defaults and keeps a backup", async () => {
		const dataDir = await tempDataDir()
		const current = renderDefaultRulesMarkdown()
		// An older seed: a different yaml block, with the marker that matched it.
		const olderBody = current
			.replace(/^<!--.*-->\n/, "")
			.replace("snps-provider/kimi-k2.6\n      - snps-provider/qwen3-coder", "snps-provider/qwen3-coder")
		expect(extractYamlBlock(olderBody)).not.toBe(extractYamlBlock(current))
		const older = `${seedMarker(olderBody)}\n${olderBody}`
		expect(isUntouchedSeed(older)).toBe(true)
		const filePath = path.join(dataDir, "pliny-free-auto.md")
		await fs.writeFile(filePath, older, "utf8")

		expect(await initialiseDefaultRulesFile(dataDir)).toBe(filePath)
		expect(await fs.readFile(filePath, "utf8")).toBe(current)
		expect(await fs.readFile(`${filePath}.bak`, "utf8")).toBe(older)
	})
})
