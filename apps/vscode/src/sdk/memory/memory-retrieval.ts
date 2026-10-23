import { CHARS_PER_TOKEN } from "@plinycode/shared"
import type { MemoryEntry } from "@shared/memory"
import { listMemoryEntries } from "./memory-file"
import { MEMORY_INSTRUCTIONS, type RenderedMemorySection } from "./memory-section"
import type { MemoryContents } from "./memory-store"

export interface MemorySelection extends RenderedMemorySection {
	source: MemoryContents
	retrieved: boolean
	userShare: number
	budget: number
	relevant: string
	loaded: { entry: MemoryEntry; tier: "always" | "retrieved" }[]
	cut: MemoryEntry[]
}

const STOP_WORDS = new Set(["the", "with", "and", "for", "this", "that", "from", "when", "use", "should"])
function words(text: string): string[] {
	return (
		text
			.toLowerCase()
			.match(/[\p{L}\p{N}_-]{2,}/gu)
			?.filter((word) => !STOP_WORDS.has(word)) ?? []
	)
}

/** BM25 over the small local entry set. */
export function rankMemories(
	entries: readonly MemoryEntry[],
	query: string,
	usage: Record<string, { count?: number; used?: string }> = {},
): MemoryEntry[] {
	const terms = [...new Set(words(query))]
	const docs = entries.map((entry) => words(entry.text))
	const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length)
	const frequencies = new Map(terms.map((term) => [term, docs.filter((doc) => doc.includes(term)).length]))
	return entries
		.map((entry, index) => {
			const doc = docs[index]
			const score = terms.reduce((sum, term) => {
				const frequency = doc.filter((word) => word === term).length
				const documentFrequency = frequencies.get(term) ?? 0
				return (
					sum +
					(Math.log(1 + (entries.length - documentFrequency + 0.5) / (documentFrequency + 0.5)) * (frequency * 2.2)) /
						(frequency + 1.2 * (0.25 + (0.75 * doc.length) / (average || 1)))
				)
			}, 0)
			return { entry, score, index }
		})
		.filter((item) => item.score > 0)
		.sort(
			(a, b) =>
				b.score - a.score ||
				Number(b.entry.pinned) - Number(a.entry.pinned) ||
				Number(b.entry.importance === "high") - Number(a.entry.importance === "high") ||
				(usage[b.entry.id]?.count ?? 0) - (usage[a.entry.id]?.count ?? 0) ||
				(usage[b.entry.id]?.used ?? b.entry.used ?? b.entry.added ?? "").localeCompare(
					usage[a.entry.id]?.used ?? a.entry.used ?? a.entry.added ?? "",
				) ||
				a.index - b.index,
		)
		.map((item) => item.entry)
}

function memoryEntries(contents: MemoryContents): MemoryEntry[] {
	return [
		...listMemoryEntries(contents.repoText, "repo"),
		...listMemoryEntries(contents.groupText ?? "", "group"),
		...listMemoryEntries(contents.userText, "user"),
	]
}

/** The system tier is independent of the task. The remaining budget holds relevant notes. */
export function selectMemories(
	contents: MemoryContents,
	maxTokens: number,
	query?: string,
	usage: Record<string, { count?: number; used?: string }> = {},
	userShare = 25,
): MemorySelection {
	const entries = memoryEntries(contents)
	const limit = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN))
	const header = `\n\n# Memory\n\n${MEMORY_INSTRUCTIONS}\n\nUse recall_memory to search other notes.\n`
	let system = header.length <= limit ? header : ""
	const loaded: MemorySelection["loaded"] = []
	let userChars = 0
	const userLimit = Math.floor((limit * userShare) / 100)
	for (const scope of ["repo", "group", "user"] as const) {
		let headingAdded = false
		const heading = `\n## ${scope === "repo" ? "Repository memory" : scope === "group" ? "Group memory" : "Your memory"}\n### Important\n`
		for (const entry of entries.filter(
			(item) =>
				item.scope === scope &&
				(item.pinned ||
					(scope === "user"
						? item.type === "preference" || (!item.type && item.importance === "high")
						: item.importance === "high")),
		)) {
			const addition = `${headingAdded ? "" : heading}- ${entry.text}\n`
			if (
				!system ||
				system.length + addition.length > limit ||
				(scope === "user" && userChars + addition.length > userLimit)
			)
				continue
			system += addition
			headingAdded = true
			if (scope === "user") userChars += addition.length
			loaded.push({ entry, tier: "always" })
		}
	}
	let relevant = ""
	if (query !== undefined && system) {
		const others = entries.filter((entry) => !loaded.some((item) => item.entry.id === entry.id))
		const ranked = rankMemories(others, query, usage)
		const selected = ranked.length ? ranked : others
		const prefix = "<relevant_memories>\nNotes from earlier work; current user instructions take precedence.\n"
		const suffix = "</relevant_memories>"
		const lines: string[] = []
		for (const entry of selected) {
			const line = `- [${entry.scope}] ${entry.text}\n`
			if (
				system.length + prefix.length + lines.join("").length + line.length + suffix.length > limit ||
				(entry.scope === "user" && userChars + line.length > userLimit)
			)
				continue
			lines.push(line)
			if (entry.scope === "user") userChars += line.length
			loaded.push({ entry, tier: "retrieved" })
		}
		if (lines.length) relevant = `${prefix}${lines.join("")}${suffix}`
	}
	const cut = entries.filter((entry) => !loaded.some((item) => item.entry.id === entry.id))
	return {
		source: contents,
		userShare,
		retrieved: query !== undefined,
		text: system,
		relevant,
		loaded,
		cut,
		budget: maxTokens,
		summary: { entries: loaded.length, droppedEntries: cut.length, chars: system.length + relevant.length },
	}
}
