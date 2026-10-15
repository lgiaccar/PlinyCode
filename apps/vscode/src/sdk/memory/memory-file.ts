// The MEMORY.md format (docs/memory.md): plain markdown whose order is its
// priority. The most important entries come first, so a smaller budget keeps
// the top of the file and drops the bottom.
//
// An entry is a top-level bullet with every line under it (continuation
// lines, nested bullets), or a heading. Truncation keeps whole entries, and
// `save_memory` inserts deterministically: an important entry at the top of
// `## Important`, any other at the top of `## Notes`. Both go first in their
// section because truncation cuts from the bottom: a new note appended last
// to a file already over the budget would be the first thing left out.

export const MEMORY_FILE_NAME = "MEMORY.md"
const IMPORTANT_HEADING = "## Important"
const NOTES_HEADING = "## Notes"
/** Longest single entry `save_memory` accepts for the index; detail goes in a topic file. */
export const MAX_ENTRY_CHARS = 600

export function memoryFileTemplate(title: string): string {
	return `# ${title}\n\n${IMPORTANT_HEADING}\n\n${NOTES_HEADING}\n`
}

interface MemoryBlock {
	kind: "preamble" | "heading" | "entry"
	text: string
}

const HEADING = /^ {0,3}#{1,6}(\s|$)/
const TOP_LEVEL_BULLET = /^[-*+] |^\d+[.)] /
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** Splits a memory file into its preamble, headings and entries, in order. */
function parseBlocks(text: string): MemoryBlock[] {
	const blocks: MemoryBlock[] = []
	let current: MemoryBlock | undefined
	let fence: string | undefined
	for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
		if (fence) {
			if (line.trimStart().startsWith(fence)) {
				fence = undefined
			}
			if (current) current.text += `\n${line}`
			continue
		}
		const opening = line.match(FENCE)
		if (HEADING.test(line)) {
			current = { kind: "heading", text: line }
			blocks.push(current)
			// A heading is one line; what follows starts a new block.
			current = undefined
			continue
		}
		if (TOP_LEVEL_BULLET.test(line)) {
			current = { kind: "entry", text: line }
			blocks.push(current)
		} else if (current) {
			current.text += `\n${line}`
		} else if (line.trim()) {
			current = { kind: blocks.length === 0 ? "preamble" : "entry", text: line }
			blocks.push(current)
		}
		if (opening) {
			fence = opening[1]
		}
	}
	for (const block of blocks) {
		block.text = block.text.replace(/\s+$/, "")
	}
	return blocks
}

function headingLevel(line: string): number {
	return line.trimStart().match(/^#+/)?.[0].length ?? 0
}

/** The number of entries (not headings) in a memory file. */
export function countMemoryEntries(text: string): number {
	return parseBlocks(text).filter((block) => block.kind === "entry").length
}

/**
 * The entries of a memory file, each as `save_memory` compares them: one line,
 * lower case, single spaces, without the `(details: …)` pointer. A proposal or
 * an insertion is a duplicate when its key is in this set: whole entries, so a
 * short memory that happens to occur inside a longer one is not a duplicate.
 */
export function memoryEntryKeys(text: string): Set<string> {
	const keys = new Set<string>()
	for (const block of parseBlocks(text)) {
		if (block.kind === "entry") {
			keys.add(memoryEntryKey(block.text.replace(/ \(details: [^)]*\)$/, "")))
		}
	}
	return keys
}

/** How two entries are compared: see memoryEntryKeys. */
export function memoryEntryKey(text: string): string {
	return comparable(text)
}

interface TruncatedMemory {
	text: string
	keptEntries: number
	droppedEntries: number
}

/**
 * The longest prefix of whole blocks that fits in `maxChars`. A heading is
 * kept only when an entry after it fits too, so the cut never leaves an empty
 * section at the end.
 */
export function truncateMemory(text: string, maxChars: number): TruncatedMemory {
	const blocks = parseBlocks(text)
	let out = ""
	let previous: MemoryBlock | undefined
	// Headings wait for the next entry: they are only written if it fits.
	const pendingHeadings: MemoryBlock[] = []
	let keptEntries = 0
	let index = 0
	const append = (base: string, block: MemoryBlock, before: MemoryBlock | undefined) => {
		if (!before) return block.text
		// Entries of one list stay together; headings get a blank line around them.
		const separator = before.kind === "heading" || block.kind !== "entry" || before.kind !== "entry" ? "\n\n" : "\n"
		return `${base}${separator}${block.text}`
	}
	for (; index < blocks.length; index++) {
		const block = blocks[index]
		if (block.kind === "heading") {
			// A pending heading at this level or deeper had no entries: an empty section.
			const level = headingLevel(block.text)
			while (pendingHeadings.length > 0 && headingLevel(pendingHeadings[pendingHeadings.length - 1].text) >= level) {
				pendingHeadings.pop()
			}
			pendingHeadings.push(block)
			continue
		}
		let candidate = out
		let last = previous
		for (const heading of [...pendingHeadings, block]) {
			candidate = append(candidate, heading, last)
			last = heading
		}
		if (candidate.length > maxChars) {
			break
		}
		out = candidate
		previous = last
		pendingHeadings.length = 0
		if (block.kind === "entry") {
			keptEntries++
		}
	}
	const droppedEntries = blocks.slice(index).filter((block) => block.kind === "entry").length
	return { text: out, keptEntries, droppedEntries }
}

/** One line, no leading bullet, bounded. */
export function normalizeEntryText(text: string): string {
	const oneLine = text
		.replace(/\s*\r?\n\s*/g, " ")
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
		.trim()
	return oneLine.length > MAX_ENTRY_CHARS ? `${oneLine.slice(0, MAX_ENTRY_CHARS - 1)}…` : oneLine
}

function comparable(line: string): string {
	return normalizeEntryText(line).toLowerCase().replace(/\s+/g, " ")
}

interface MemoryInsertion {
	text: string
	importance: "high" | "normal"
	/** Appended to the entry as ` (details: <topicFile>)`. */
	topicFile?: string
}

interface InsertResult {
	content: string
	/** False when the same entry was already there; `content` is then unchanged. */
	inserted: boolean
}

function lineIndexOfHeading(lines: string[], heading: string): number {
	return lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase())
}

/**
 * Adds one entry. An important one goes first under `## Important`, which
 * puts it at the top of what a small budget keeps; any other goes first under
 * `## Notes`, newest first, so that a file over the budget drops its oldest
 * notes rather than the one just saved. Missing sections are created.
 */
export function insertMemoryEntry(content: string, insertion: MemoryInsertion, title = "Memory"): InsertResult {
	const entryText = normalizeEntryText(insertion.text)
	const line = `- ${entryText}${insertion.topicFile ? ` (details: ${insertion.topicFile})` : ""}`
	const base = content.trim() ? content.replace(/\r\n/g, "\n") : memoryFileTemplate(title)
	const target = comparable(entryText)
	const existing = parseBlocks(base).some(
		(block) => block.kind === "entry" && comparable(block.text.replace(/ \(details: [^)]*\)$/, "")) === target,
	)
	if (existing) {
		return { content: base, inserted: false }
	}

	const lines = base.replace(/\n+$/, "").split("\n")
	let headingIndex: number
	if (insertion.importance === "high") {
		headingIndex = lineIndexOfHeading(lines, IMPORTANT_HEADING)
		if (headingIndex < 0) {
			// After the file's title and any intro, before the first section.
			const firstSection = lines.findIndex((text, index) => index > 0 && /^ {0,3}##\s/.test(text))
			const at = firstSection < 0 ? lines.length : firstSection
			lines.splice(at, 0, ...(at > 0 && lines[at - 1].trim() ? [""] : []), IMPORTANT_HEADING, "")
			headingIndex = lineIndexOfHeading(lines, IMPORTANT_HEADING)
		}
	} else {
		headingIndex = lineIndexOfHeading(lines, NOTES_HEADING)
		if (headingIndex < 0) {
			lines.push("", NOTES_HEADING)
			headingIndex = lines.length - 1
		}
	}
	// First entry of the section: right after its heading and the blank line under it.
	let at = headingIndex + 1
	while (at < lines.length && !lines[at].trim()) {
		at++
	}
	lines.splice(at, 0, ...(at === headingIndex + 1 ? ["", line] : [line]))
	return { content: tidy(lines.join("\n")), inserted: true }
}

/** At most one blank line in a row, a blank line before each heading, and one trailing newline. */
function tidy(text: string): string {
	const out: string[] = []
	for (const line of text.split("\n")) {
		const blank = !line.trim()
		if (blank && (out.length === 0 || !out[out.length - 1].trim())) {
			continue
		}
		if (HEADING.test(line) && out.length > 0 && out[out.length - 1].trim()) {
			out.push("")
		}
		out.push(blank ? "" : line)
	}
	return `${out.join("\n").replace(/\n+$/, "")}\n`
}

/** Pushes every heading down `levels` (to at most `######`), outside fenced code. */
export function nestHeadings(text: string, levels: number): string {
	let fence: string | undefined
	return text
		.split("\n")
		.map((line) => {
			if (fence) {
				if (line.trimStart().startsWith(fence)) {
					fence = undefined
				}
				return line
			}
			const opening = line.match(FENCE)
			if (opening) {
				fence = opening[1]
				return line
			}
			return line.replace(
				/^( {0,3})(#{1,6})(?=\s|$)/,
				(_match, indent: string, hashes: string) => `${indent}${"#".repeat(Math.min(6, hashes.length + levels))}`,
			)
		})
		.join("\n")
}
