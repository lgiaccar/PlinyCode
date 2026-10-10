import { describe, expect, it } from "vitest"
import {
	countMemoryEntries,
	insertMemoryEntry,
	MAX_ENTRY_CHARS,
	memoryFileTemplate,
	nestHeadings,
	normalizeEntryText,
	truncateMemory,
} from "./memory-file"

const FILE = `# Repository memory

## Important

- Never run \`bun run fix:all\` in apps/vscode: it rewrites ~200 files.
- PRs target stage, not master.

## Notes

- The engine resolves through dist/: run build:sdk after engine changes.
  It does not hot-reload either.
- Biome formats only the files you pass.
`

describe("truncateMemory", () => {
	it("keeps everything that fits", () => {
		const result = truncateMemory(FILE, 10_000)
		expect(result.droppedEntries).toBe(0)
		expect(result.keptEntries).toBe(4)
		expect(result.text).toBe(FILE.trim())
	})

	it("drops whole entries from the bottom, so the most important stay", () => {
		const half = truncateMemory(FILE, 200)
		expect(half.text).toContain("Never run")
		expect(half.text).toContain("PRs target stage")
		expect(half.text).not.toContain("Biome formats")
		expect(half.droppedEntries).toBeGreaterThan(0)
		expect(half.keptEntries + half.droppedEntries).toBe(4)
		// Never part of an entry.
		for (const line of half.text.split("\n")) {
			expect(FILE).toContain(line)
		}
	})

	it("keeps an entry's continuation lines with it", () => {
		const upToEngine = FILE.indexOf("- Biome")
		const result = truncateMemory(FILE, upToEngine)
		expect(result.text).toContain("It does not hot-reload either.")
		expect(result.droppedEntries).toBe(1)
	})

	it("does not end on a heading whose entries were cut", () => {
		const beforeNotes = FILE.indexOf("## Notes") + "## Notes".length + 5
		const result = truncateMemory(FILE, beforeNotes)
		expect(result.text.trimEnd().endsWith("## Notes")).toBe(false)
		expect(result.droppedEntries).toBe(2)
	})

	it("leaves out a section with no entries", () => {
		const result = truncateMemory("# M\n\n## Important\n\n## Notes\n\n- only note", 1000)
		expect(result.text).toBe("# M\n\n## Notes\n\n- only note")
	})

	it("lowering the budget only ever removes from the end", () => {
		const big = truncateMemory(FILE, 300).text
		const small = truncateMemory(FILE, 150).text
		expect(big.startsWith(small)).toBe(true)
	})

	it("treats a fenced block inside an entry as part of it", () => {
		const text = "- Run this:\n  ```\n  # not a heading\n  - not an entry\n  ```\n- Second"
		expect(countMemoryEntries(text)).toBe(2)
	})
})

describe("insertMemoryEntry", () => {
	it("creates the file from the template", () => {
		const result = insertMemoryEntry("", { text: "Use bun, not npm", importance: "normal" }, "Repository memory")
		expect(result.inserted).toBe(true)
		expect(result.content).toBe("# Repository memory\n\n## Important\n\n## Notes\n\n- Use bun, not npm\n")
	})

	it("puts an important entry first under Important", () => {
		const result = insertMemoryEntry(FILE, { text: "Ask before pushing", importance: "high" })
		const lines = result.content.split("\n")
		const heading = lines.indexOf("## Important")
		expect(lines[heading + 1]).toBe("")
		expect(lines[heading + 2]).toBe("- Ask before pushing")
		expect(lines[heading + 3]).toBe("- Never run `bun run fix:all` in apps/vscode: it rewrites ~200 files.")
	})

	it("puts a normal entry first under Notes, so truncation drops older notes before it", () => {
		const result = insertMemoryEntry(FILE, { text: "Logs go to ai_output/", importance: "normal" })
		const lines = result.content.split("\n")
		const heading = lines.indexOf("## Notes")
		expect(lines[heading + 1]).toBe("")
		expect(lines[heading + 2]).toBe("- Logs go to ai_output/")
		expect(lines[heading + 3]).toBe("- The engine resolves through dist/: run build:sdk after engine changes.")
		expect(result.content.endsWith("- Biome formats only the files you pass.\n")).toBe(true)
		// The new note survives a budget that cuts the end of the file.
		const kept = truncateMemory(result.content, result.content.indexOf("- Biome"))
		expect(kept.text).toContain("- Logs go to ai_output/")
		expect(kept.droppedEntries).toBe(1)
	})

	it("inserts into Notes without touching the section after it", () => {
		const content = "# M\n\n## Notes\n\n- a\n\n## Archive\n\n- old\n"
		const result = insertMemoryEntry(content, { text: "b", importance: "normal" })
		expect(result.content).toBe("# M\n\n## Notes\n\n- b\n- a\n\n## Archive\n\n- old\n")
	})

	it("adds missing sections", () => {
		const high = insertMemoryEntry("# Mine\n\nSome intro.\n", { text: "x", importance: "high" })
		expect(high.content).toBe("# Mine\n\nSome intro.\n\n## Important\n\n- x\n")
		const normal = insertMemoryEntry("# Mine\n", { text: "y", importance: "normal" })
		expect(normal.content).toBe("# Mine\n\n## Notes\n\n- y\n")
	})

	it("does not add an entry that is already there", () => {
		const result = insertMemoryEntry(FILE, { text: "  prs target STAGE, not master. ", importance: "normal" })
		expect(result.inserted).toBe(false)
		expect(result.content).toBe(FILE)
	})

	it("points to a topic file", () => {
		const result = insertMemoryEntry(memoryFileTemplate("M"), {
			text: "Build quirks",
			importance: "normal",
			topicFile: "build.md",
		})
		expect(result.content).toContain("- Build quirks (details: build.md)")
	})
})

describe("normalizeEntryText", () => {
	it("makes one bounded line without a bullet", () => {
		expect(normalizeEntryText("- first\n  second")).toBe("first second")
		expect(normalizeEntryText("1. numbered")).toBe("numbered")
		const long = normalizeEntryText("x".repeat(MAX_ENTRY_CHARS + 50))
		expect(long).toHaveLength(MAX_ENTRY_CHARS)
		expect(long.endsWith("…")).toBe(true)
	})
})

describe("nestHeadings", () => {
	it("pushes headings down outside code fences", () => {
		expect(nestHeadings("# A\n## B\n```\n# code\n```\n###### F", 2)).toBe("### A\n#### B\n```\n# code\n```\n###### F")
	})
})
