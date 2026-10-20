import { describe, expect, it } from "vitest"
import {
	countMemoryEntries,
	hasNearDuplicate,
	insertMemoryEntry,
	MAX_ENTRY_CHARS,
	memoryDate,
	memoryEntryKeys,
	memoryFileTemplate,
	nestHeadings,
	normalizeEntryText,
	removeMemoryEntries,
	selectCleanupEntries,
	selectStaleEntries,
	stripEntryMeta,
	touchMemoryEntries,
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

describe("entry dates", () => {
	const TODAY = "2026-10-17"

	it("dates a new entry, stamps undated ones, and keeps hand-written text", () => {
		const result = insertMemoryEntry(FILE, { text: "Logs go to ai_output/", importance: "normal", date: TODAY })
		expect(result.inserted).toBe(true)
		expect(result.content).toContain("- Logs go to ai_output/ <!-- added:2026-10-17 -->")
		// The entries written by hand get today's date too, so they start ageing.
		expect(result.content).toContain("- PRs target stage, not master. <!-- added:2026-10-17 -->")
		// A continuation line stays where it was, below its dated bullet.
		expect(result.content).toContain(
			"- The engine resolves through dist/: run build:sdk after engine changes. <!-- added:2026-10-17 -->\n  It does not hot-reload either.",
		)
	})

	it("round-trips: a dated entry is recognised, bumped and stripped for the prompt", () => {
		const content =
			"# M\n\n## Notes\n\n- Use bun <!-- added:2026-01-05 -->\n- Other <!-- added:2026-01-05 used:2026-02-01 pinned -->\n"
		const touched = touchMemoryEntries(content, ["use bun"], TODAY)
		expect(touched.touched).toBe(1)
		expect(touched.content).toContain("- Use bun <!-- added:2026-01-05 used:2026-10-17 -->")
		expect(touched.content).toContain("- Other <!-- added:2026-01-05 used:2026-02-01 pinned -->")
		expect(stripEntryMeta(touched.content)).toBe("# M\n\n## Notes\n\n- Use bun\n- Other\n")
		// The comment does not change how an entry compares.
		expect(memoryEntryKeys(touched.content)).toEqual(new Set(["use bun", "other"]))
	})

	it("parses hand-edited comments tolerantly and treats mangled ones as undated", () => {
		const content = [
			"## Notes",
			"- Spelled out <!-- Added: 2026-01-01 -->",
			"- Equals and last_used <!--added=2026-01-01 last_used=2026-02-01-->",
			"- Moved to the middle <!-- added:2026-01-03 --> of the line",
			"- Impossible date <!-- added:2026-13-45 -->",
			"- Not ours <!-- a note to self -->",
			"- No comment at all",
		].join("\n")
		expect(selectStaleEntries(content, TODAY, 90, 10).map((entry) => entry.text)).toEqual([
			"Spelled out",
			"Moved to the middle of the line",
			"Equals and last_used",
		])
		// Another comment is the user's: it stays in the prompt.
		expect(stripEntryMeta(content)).toContain("- Not ours <!-- a note to self -->")
	})

	it("uses the local date", () => {
		expect(memoryDate(new Date(2026, 0, 2, 23, 59))).toBe("2026-01-02")
	})
})

describe("near duplicates", () => {
	const BASE = "# M\n\n## Notes\n\n- Run build sdk after engine changes <!-- added:2026-01-01 -->\n"

	it("bumps the existing entry instead of adding a near duplicate", () => {
		const result = insertMemoryEntry(BASE, {
			text: "run build:sdk after engine changes, always.",
			importance: "high",
			date: "2026-10-17",
		})
		expect(result.inserted).toBe(false)
		expect(result.duplicateOf).toBe("Run build sdk after engine changes")
		expect(result.content).toBe(
			"# M\n\n## Notes\n\n- Run build sdk after engine changes <!-- added:2026-01-01 used:2026-10-17 -->\n",
		)
	})

	it("draws the line at 0.7 Jaccard similarity of the significant words", () => {
		// 6 of 7 words shared: 0.86.
		expect(hasNearDuplicate(BASE, "Run build sdk after the engine changes again")).toBe(true)
		// 6 of 8: 0.75, a trailing clause added to the same memory.
		expect(hasNearDuplicate(BASE, "Run build sdk after engine changes and restart vscode")).toBe(true)
		// 5 of 10: 0.5, and a different opening.
		expect(hasNearDuplicate(BASE, "Run build sdk before engine changes and then restart the vscode window")).toBe(false)
		// Stop words and punctuation do not count.
		expect(hasNearDuplicate(BASE, "Run `build:sdk` after the engine changes.")).toBe(true)
		expect(hasNearDuplicate(BASE, "Run the tests after engine changes")).toBe(false)
	})

	it("treats entries that open with the same six significant words as one", () => {
		const content =
			"## Notes\n\n- Release workflow: build CLI with gpu_surfer_make.bat release cli, then run package_cli.ps1 to create a versioned subfolder under OneDrive\n"
		// Only 7 of 15 words are shared (0.47), but the opening is the same memory.
		expect(hasNearDuplicate(content, "Release workflow: build CLI with gpu_surfer_make.bat release cli")).toBe(true)
		expect(hasNearDuplicate(content, "Release notes: build CLI with gpu_surfer_make.bat release cli")).toBe(false)
	})

	it("offers change-log and duplicate entries for cleanup, the longest wording kept", () => {
		const content = [
			"# M",
			"",
			"## Important",
			"",
			"- Fixed LineFilterBuf::sync() bug: now flushes the buffer <!-- added:2026-10-19 -->",
			"- Always use py.exe when python is not on PATH <!-- added:2026-10-19 -->",
			"- Pinned change: added a helper <!-- added:2026-10-19 pinned -->",
			"",
			"## Notes",
			"",
			"- Release workflow: build with make.bat release cli, then run package_cli.ps1 -OutDir <path> <!-- added:2026-10-19 -->",
			"- Release workflow: build with make.bat release cli, then run package_cli.ps1 -OutDir <path> -PackageVersion <ver> to create a versioned subfolder <!-- added:2026-10-19 -->",
			"- Kept on purpose: removed the old flag <!-- added:2026-01-01 used:2026-10-19 -->",
			"",
		].join("\n")
		const isChangeLog = (text: string) => /^(fixed|added|removed)\b|: (added|removed) /i.test(text)
		expect(selectCleanupEntries(content, isChangeLog, "2026-10-20", 8)).toEqual([
			{ text: "Fixed LineFilterBuf::sync() bug: now flushes the buffer", reason: "change-log" },
			{
				text: "Release workflow: build with make.bat release cli, then run package_cli.ps1 -OutDir <path>",
				reason: "duplicate",
			},
		])
		expect(selectCleanupEntries(content, isChangeLog, "2026-10-20", 1)).toHaveLength(1)
	})

	it("never treats a memory and its negation as duplicates", () => {
		const content = "## Notes\n\n- Run the full test suite before pushing to the stage branch every time\n"
		expect(hasNearDuplicate(content, "Never run the full test suite before pushing to the stage branch every time")).toBe(
			false,
		)
		expect(hasNearDuplicate(content, "Run full test suite before pushing to stage branch every single time")).toBe(true)
	})

	it("adds the topic pointer to the entry a duplicate with details matched", () => {
		const result = insertMemoryEntry(BASE, {
			text: "Run build sdk after engine changes",
			importance: "normal",
			topicFile: "engine.md",
			date: "2026-10-17",
		})
		expect(result.content).toContain(
			"- Run build sdk after engine changes (details: engine.md) <!-- added:2026-01-01 used:2026-10-17 -->",
		)
	})
})

describe("pruning", () => {
	const CONTENT = [
		"# M",
		"",
		"## Important",
		"",
		"- Important and old <!-- added:2025-01-01 -->",
		"",
		"## Notes",
		"",
		"- Recently used <!-- added:2025-01-01 used:2026-10-01 -->",
		"- Oldest <!-- added:2025-03-01 -->",
		"- Old with detail (details: old.md) <!-- added:2026-05-01 -->",
		"  - a nested line",
		"- Pinned <!-- added:2025-01-01 pinned -->",
		"- Exactly 89 days <!-- added:2026-07-20 -->",
		"- Undated",
		"",
	].join("\n")

	it("selects entries not used for 90 days, oldest first, never important, pinned or undated ones", () => {
		expect(selectStaleEntries(CONTENT, "2026-10-17")).toEqual([
			{ text: "Oldest", lastUsed: "2025-03-01" },
			{ text: "Old with detail (details: old.md) - a nested line", lastUsed: "2026-05-01" },
		])
		expect(selectStaleEntries(CONTENT, "2026-10-17", 90, 1)).toHaveLength(1)
		expect(selectStaleEntries(CONTENT, "2026-10-18").map((entry) => entry.text)).toContain("Exactly 89 days")
	})

	it("removes exactly the approved entries with their lines and reports orphaned topic files", () => {
		const result = removeMemoryEntries(CONTENT, ["Oldest", "Old with detail (details: old.md) - a nested line", "Gone"])
		expect(result.removed).toBe(2)
		expect(result.orphanedTopicFiles).toEqual(["old.md"])
		expect(result.content).not.toContain("Oldest")
		expect(result.content).not.toContain("a nested line")
		expect(result.content).toContain("- Recently used <!-- added:2025-01-01 used:2026-10-01 -->\n- Pinned")
		expect(removeMemoryEntries(CONTENT, ["oldest entry"]).removed).toBe(0)
	})
})
