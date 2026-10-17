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
//
// Dates: an entry's first line may end with a comment such as
// `<!-- added:2026-10-17 used:2026-11-02 pinned -->`. `added` is when it was
// saved, `used` the last time it was saved again or matched by a duplicate
// (or kept when proposed for removal), and `pinned` keeps it out of prune
// proposals. The comment is stripped from the prompt, so it costs no tokens
// there, and parsed tolerantly: a missing, partial or hand-mangled comment
// leaves the entry valid, only undated. Writes through `save_memory` stamp
// undated entries with today's date, so hand-written entries start ageing too.

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

// ---------------------------------------------------------------------------
// Entry dates

interface EntryDates {
	/** YYYY-MM-DD */
	added?: string
	/** YYYY-MM-DD */
	used?: string
	pinned: boolean
}

const META_SOURCE = String.raw`[ \t]*<!--\s*(?:added|used|last[_-]?used|pinned)\b[^>]*?-->`
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DETAILS_SUFFIX = / \(details: [^)]*\)$/
const DAY_MS = 24 * 60 * 60 * 1000

function validDate(value: string | undefined): string | undefined {
	return value && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : undefined
}

/** The dates in an entry's comment; an entry without one (or with a mangled one) is undated. */
function parseEntryDates(text: string): EntryDates {
	const comment = text.match(new RegExp(META_SOURCE, "i"))?.[0] ?? ""
	return {
		added: validDate(comment.match(/\badded\s*[:= ]\s*(\d{4}-\d{2}-\d{2})/i)?.[1]),
		used: validDate(comment.match(/\b(?:last[_-]?)?used\s*[:= ]\s*(\d{4}-\d{2}-\d{2})/i)?.[1]),
		pinned: /\bpinned\b/i.test(comment),
	}
}

/** `<!-- added:2026-10-17 used:2026-11-02 pinned -->`; `used` is left out while it equals `added`. */
function formatEntryDates(dates: EntryDates): string {
	const parts: string[] = []
	if (dates.added) parts.push(`added:${dates.added}`)
	if (dates.used && dates.used !== dates.added) parts.push(`used:${dates.used}`)
	if (dates.pinned) parts.push("pinned")
	return parts.length > 0 ? `<!-- ${parts.join(" ")} -->` : ""
}

/** The text without its date comments: what the prompt shows. */
export function stripEntryMeta(text: string): string {
	return text.replace(new RegExp(META_SOURCE, "gi"), "")
}

/** The later of an entry's two dates. */
function lastUsedDate(dates: EntryDates): string | undefined {
	if (dates.added && dates.used) return dates.used > dates.added ? dates.used : dates.added
	return dates.used ?? dates.added
}

/** Today in the local time zone, as entries record it. */
export function memoryDate(now: Date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0")
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function daysBetween(from: string, to: string): number {
	return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

/** The line with its date comment replaced by `update`'s, at the end. */
function withDates(line: string, update: (dates: EntryDates) => EntryDates, bare = (text: string) => text): string {
	const meta = formatEntryDates(update(parseEntryDates(line)))
	const text = bare(stripEntryMeta(line).replace(/\s+$/, ""))
	return meta ? `${text} ${meta}` : text
}

// ---------------------------------------------------------------------------
// Entries by line, for the edits that keep the rest of the file as it is

interface EntryRange {
	/** First line (the bullet). */
	start: number
	/** One past the last non-blank line. */
	end: number
	/** The `##` section the entry is in, lower case, without the hashes. */
	section: string
}

/** The top-level bullet entries of a file, by line (the same entries parseBlocks finds). */
function entryRanges(lines: readonly string[]): EntryRange[] {
	const ranges: EntryRange[] = []
	let current: EntryRange | undefined
	let section = ""
	let fence: string | undefined
	for (const [index, line] of lines.entries()) {
		if (fence) {
			if (line.trimStart().startsWith(fence)) fence = undefined
			if (current) current.end = index + 1
			continue
		}
		if (HEADING.test(line)) {
			current = undefined
			if (headingLevel(line) <= 2) {
				section = line
					.trim()
					.replace(/^#+\s*/, "")
					.toLowerCase()
			}
			continue
		}
		if (TOP_LEVEL_BULLET.test(line)) {
			current = { start: index, end: index + 1, section }
			ranges.push(current)
		} else if (current && line.trim()) {
			current.end = index + 1
		}
		const opening = line.match(FENCE)
		if (opening) fence = opening[1]
	}
	return ranges
}

function rangeText(lines: readonly string[], range: EntryRange): string {
	return lines.slice(range.start, range.end).join("\n")
}

/** How an entry is identified for removal: memoryEntryKey of its text without dates and topic pointer. */
function entryKey(text: string): string {
	return comparable(normalizeEntryText(text).replace(DETAILS_SUFFIX, ""))
}

/** Stamps every undated entry with `date`. */
function stampUndated(lines: string[], ranges: readonly EntryRange[], date: string): void {
	for (const range of ranges) {
		const dates = parseEntryDates(lines[range.start])
		if (!dates.added && !dates.used) {
			lines[range.start] = withDates(lines[range.start], (current) => ({ ...current, added: date }))
		}
	}
}

// ---------------------------------------------------------------------------
// Near duplicates

/** Similarity at or above which a new memory is the same as an existing entry. */
const NEAR_DUPLICATE_SIMILARITY = 0.8

// Words too common to tell two memories apart. Negations (not, no, never) are
// not here: "use npm" and "never use npm" must stay different.
const STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"and",
	"or",
	"of",
	"to",
	"in",
	"on",
	"at",
	"by",
	"for",
	"from",
	"with",
	"as",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"it",
	"its",
	"this",
	"that",
	"these",
	"those",
	"so",
	"then",
	"there",
	"here",
	"into",
	"than",
	"also",
	"just",
])

// A memory and its negation share almost every word: never duplicates.
const NEGATIONS = new Set(["not", "no", "never", "don", "dont", "doesn", "isn", "avoid", "without"])

function entryTokens(text: string): Set<string> {
	return new Set(
		normalizeEntryText(text.replace(DETAILS_SUFFIX, ""))
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.split(" ")
			.filter((word) => word && !STOP_WORDS.has(word)),
	)
}

/**
 * Jaccard similarity of two memories' word sets: lower case, punctuation and
 * very common words left out. 1 for the same words in any order, 0 when only
 * one of them is negated.
 */
function entrySimilarity(a: string, b: string): number {
	const left = entryTokens(a)
	const right = entryTokens(b)
	if (left.size === 0 || right.size === 0) {
		return comparable(a) === comparable(b) ? 1 : 0
	}
	const negated = (words: Set<string>) => [...words].some((word) => NEGATIONS.has(word))
	if (negated(left) !== negated(right)) {
		return 0
	}
	let shared = 0
	for (const word of left) {
		if (right.has(word)) shared++
	}
	return shared / (left.size + right.size - shared)
}

/** The entry most similar to `text`, when it is a near duplicate. */
function findDuplicateRange(lines: readonly string[], ranges: readonly EntryRange[], text: string): EntryRange | undefined {
	let best: { range: EntryRange; similarity: number } | undefined
	for (const range of ranges) {
		const similarity = entrySimilarity(stripEntryMeta(rangeText(lines, range)), text)
		if (similarity >= NEAR_DUPLICATE_SIMILARITY && (!best || similarity > best.similarity)) {
			best = { range, similarity }
		}
	}
	return best?.range
}

/** Whether `text` is a near duplicate of an entry of `content`. */
export function hasNearDuplicate(content: string, text: string): boolean {
	const lines = content.replace(/\r\n/g, "\n").split("\n")
	return findDuplicateRange(lines, entryRanges(lines), normalizeEntryText(text)) !== undefined
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
			keys.add(entryKey(block.text))
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

/** One line, no leading bullet, no date comment, bounded. */
export function normalizeEntryText(text: string): string {
	const oneLine = stripEntryMeta(text)
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
	/**
	 * Today (YYYY-MM-DD). With it the new entry is dated, a near duplicate's
	 * `used` date is bumped instead of adding a line, and undated entries are
	 * stamped. Without it only an exact duplicate is recognised and nothing is dated.
	 */
	date?: string
}

interface InsertResult {
	content: string
	/** False when the entry, or a near duplicate, was already there. */
	inserted: boolean
	/** The existing entry the memory duplicates, when it was not inserted. */
	duplicateOf?: string
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
	const pointer = insertion.topicFile ? ` (details: ${insertion.topicFile})` : ""
	const date = insertion.date
	const line = `- ${entryText}${pointer}${date ? ` ${formatEntryDates({ added: date, pinned: false })}` : ""}`
	const base = content.trim() ? content.replace(/\r\n/g, "\n") : memoryFileTemplate(title)
	const lines = base.replace(/\n+$/, "").split("\n")
	const ranges = entryRanges(lines)

	if (date) {
		stampUndated(lines, ranges, date)
		const duplicate = findDuplicateRange(lines, ranges, entryText)
		if (duplicate) {
			const duplicateOf = normalizeEntryText(rangeText(lines, duplicate))
			lines[duplicate.start] = withDates(
				lines[duplicate.start],
				(dates) => ({ ...dates, added: dates.added ?? date, used: date }),
				// Details just appended to a topic file stay reachable from the entry.
				(text) => (pointer && !text.includes("(details: ") ? `${text}${pointer}` : text),
			)
			return { content: tidy(lines.join("\n")), inserted: false, duplicateOf }
		}
	}
	const target = comparable(entryText)
	const existing = parseBlocks(base).find((block) => block.kind === "entry" && entryKey(block.text) === target)
	if (existing) {
		return { content: base, inserted: false, duplicateOf: normalizeEntryText(existing.text) }
	}

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

/**
 * Bumps the `used` date of every entry that is a near duplicate of one of
 * `texts`: they were rediscovered, or kept when proposed for removal.
 */
export function touchMemoryEntries(
	content: string,
	texts: readonly string[],
	date: string,
): { content: string; touched: number } {
	const lines = content.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n")
	const ranges = entryRanges(lines)
	let touched = 0
	for (const range of ranges) {
		const entry = stripEntryMeta(rangeText(lines, range))
		if (texts.some((text) => entrySimilarity(entry, text) >= NEAR_DUPLICATE_SIMILARITY)) {
			lines[range.start] = withDates(lines[range.start], (dates) => ({
				...dates,
				added: dates.added ?? date,
				used: date,
			}))
			touched++
		}
	}
	return touched > 0 ? { content: tidy(lines.join("\n")), touched } : { content, touched }
}

interface RemoveResult {
	content: string
	removed: number
	/** Topic files the removed entries pointed to that no remaining entry points to. */
	orphanedTopicFiles: string[]
}

/** The topic files a memory file's entries point to with `(details: …)`. */
export function referencedTopicFiles(content: string): Set<string> {
	return new Set([...content.matchAll(/\(details: ([^)]+)\)/g)].map((match) => match[1].trim()))
}

/**
 * Removes the entries whose text (without dates and topic pointer, compared
 * like memoryEntryKey) is one of `texts`. Only exact matches: an entry edited
 * since it was proposed stays.
 */
export function removeMemoryEntries(content: string, texts: readonly string[]): RemoveResult {
	const keys = new Set(texts.map(entryKey))
	const lines = content.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n")
	const doomed = entryRanges(lines).filter((range) => keys.has(entryKey(rangeText(lines, range))))
	if (doomed.length === 0) {
		return { content, removed: 0, orphanedTopicFiles: [] }
	}
	const pointedTo = new Set<string>()
	for (const range of [...doomed].reverse()) {
		for (const file of referencedTopicFiles(rangeText(lines, range))) pointedTo.add(file)
		lines.splice(range.start, range.end - range.start)
	}
	const next = tidy(lines.join("\n"))
	const stillReferenced = referencedTopicFiles(next)
	return {
		content: next,
		removed: doomed.length,
		orphanedTopicFiles: [...pointedTo].filter((file) => !stillReferenced.has(file)),
	}
}

interface StaleEntry {
	/** The entry as one line, without its dates. */
	text: string
	/** The later of its dates. */
	lastUsed: string
}

/** Days without use after which an entry is proposed for removal. */
export const STALE_AFTER_DAYS = 90

/**
 * The entries not used for `maxAgeDays`, oldest first, at most `max`.
 * Entries under `## Important`, pinned entries and undated ones are never stale.
 */
export function selectStaleEntries(content: string, today: string, maxAgeDays = STALE_AFTER_DAYS, max = 5): StaleEntry[] {
	const lines = content.replace(/\r\n/g, "\n").split("\n")
	const stale: StaleEntry[] = []
	for (const range of entryRanges(lines)) {
		if (range.section === IMPORTANT_HEADING.slice(3).toLowerCase()) continue
		const dates = parseEntryDates(lines[range.start])
		const lastUsed = lastUsedDate(dates)
		if (dates.pinned || !lastUsed || daysBetween(lastUsed, today) < maxAgeDays) continue
		stale.push({ text: normalizeEntryText(rangeText(lines, range)), lastUsed })
	}
	return stale.sort((a, b) => a.lastUsed.localeCompare(b.lastUsed)).slice(0, max)
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
