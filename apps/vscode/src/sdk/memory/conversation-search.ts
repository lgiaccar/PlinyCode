// Past-conversation search for the search_conversations and read_conversation
// tools (conversation-search-tools.ts, docs/memory.md).
//
// Backed by core's full-text index (SessionHistorySearchService: SQLite FTS5
// over every conversation's messages, side questions left out). The index is
// built on first use, not at activation: the first build reads every
// transcript. After that it is refreshed in the background, and a search
// refreshes it first so the newest conversations are found. Without SQLite
// FTS5 the search scans the most recent transcripts instead.

import { offTheRecordMessageIndices } from "@plinycode/core"
import { Logger } from "@/shared/services/Logger"
import { normalizeFolderPath } from "./repo-key"

/** The part of a session record the index and the tools read. */
export interface SearchableSession {
	sessionId: string
	startedAt: string
	updatedAt: string
	workspaceRoot: string
	prompt?: string
	messagesPath?: string
	metadata?: Record<string, unknown>
}

export interface ConversationSource {
	listSessions(limit: number): Promise<SearchableSession[]>
	readMessages(sessionId: string): Promise<unknown[]>
}

export interface IndexHit {
	sessionId: string
	ordinal: number
	role: string
	startedAt: string
	workspaceRoot: string
	title: string
	snippet: string
}

/** What this module needs from SessionHistorySearchService, so tests can pass a fake. */
export interface ConversationIndex {
	start(): void
	refreshNow(): Promise<void>
	isAvailable(): boolean
	search(input: { query: string; limit?: number }): IndexHit[]
	dispose(): Promise<void>
}

type CreateConversationIndex = (host: {
	listSessions(limit?: number): Promise<SearchableSession[]>
	readSessionMessages(sessionId: string): Promise<unknown[]>
}) => ConversationIndex

interface ConversationSearchOptions {
	source: ConversationSource
	createIndex: CreateConversationIndex
	/** How long a search waits for the index to catch up before searching what it has. */
	readyTimeoutMs?: number
}

interface ConversationSearchInput {
	query: string
	/** Only conversations that ran in this folder; all of them when undefined. */
	workspaceRoot?: string
	/** Left out of the results: the conversation that is searching. */
	excludeSessionId?: string
	limit?: number
}

const MAX_INDEXED_SESSIONS = 1000
const FALLBACK_SCAN_SESSIONS = 200
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 25
const SNIPPET_RADIUS = 120

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** The text of a message's blocks: text, tool calls on one line, tool results. Images and reasoning are left out. */
export function messageToText(message: unknown, maxToolResultChars = 300): string {
	const record = asRecord(message)
	const content = record?.content
	if (typeof content === "string") {
		return content
	}
	if (!Array.isArray(content)) {
		return ""
	}
	const parts: string[] = []
	for (const block of content) {
		const item = asRecord(block)
		if (!item) continue
		if (item.type === "text" && typeof item.text === "string") {
			parts.push(item.text)
		} else if (item.type === "tool_use") {
			parts.push(`[${String(item.name)} ${toolInputSummary(item.input)}]`)
		} else if (item.type === "tool_result") {
			const text = toolResultText(item.content)
			if (text) {
				parts.push(`[result] ${text.length > maxToolResultChars ? `${text.slice(0, maxToolResultChars)}…` : text}`)
			}
		}
	}
	return parts.join("\n")
}

function toolInputSummary(input: unknown): string {
	const record = asRecord(input)
	if (!record) return ""
	for (const key of ["path", "command", "commands", "query", "pattern", "url", "text"]) {
		const value = record[key]
		if (typeof value === "string" && value) return value.slice(0, 200)
		if (Array.isArray(value) && value.length) return value.map(String).join(" && ").slice(0, 200)
	}
	return JSON.stringify(record).slice(0, 200)
}

function toolResultText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map((part) => {
			const item = asRecord(part)
			return item?.type === "text" && typeof item.text === "string" ? item.text : ""
		})
		.filter(Boolean)
		.join("\n")
}

function titleOf(session: SearchableSession): string {
	const title = session.metadata?.title
	const text = typeof title === "string" && title.trim() ? title : (session.prompt ?? session.sessionId)
	return text.replace(/\s+/g, " ").trim().slice(0, 120)
}

function sameFolder(a: string, b: string): boolean {
	return !!a && !!b && normalizeFolderPath(a) === normalizeFolderPath(b)
}

export class ConversationSearch {
	private index: ConversationIndex | undefined

	constructor(private readonly options: ConversationSearchOptions) {}

	async search(input: ConversationSearchInput): Promise<IndexHit[]> {
		const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)
		const index = await this.readyIndex()
		const keep = (hit: IndexHit) =>
			hit.sessionId !== input.excludeSessionId &&
			(!input.workspaceRoot || sameFolder(hit.workspaceRoot, input.workspaceRoot))
		if (index) {
			// The index filters by folder with exact string equality; filter here instead.
			return index
				.search({ query: input.query, limit: Math.min(200, limit * 10) })
				.filter(keep)
				.slice(0, limit)
		}
		return (await this.scan(input.query, keep)).slice(0, limit)
	}

	/**
	 * Messages of one conversation, around `aroundOrdinal` (a hit's ordinal) or
	 * from the start, as text. Side questions are left out.
	 */
	async read(sessionId: string, aroundOrdinal: number | undefined, maxChars = 12_000): Promise<string> {
		const messages = await this.options.source.readMessages(sessionId)
		if (messages.length === 0) {
			throw new Error(`No conversation with id ${sessionId}, or it has no messages.`)
		}
		const hidden = offTheRecordMessageIndices(messages as Parameters<typeof offTheRecordMessageIndices>[0])
		const center = aroundOrdinal !== undefined && aroundOrdinal >= 0 ? Math.min(aroundOrdinal, messages.length - 1) : 0
		// Walk outward from the hit until the budget is spent.
		const picked = new Map<number, string>()
		let used = 0
		for (let distance = 0; distance < messages.length; distance++) {
			let added = false
			for (const ordinal of distance === 0 ? [center] : [center - distance, center + distance]) {
				if (ordinal < 0 || ordinal >= messages.length || hidden.has(ordinal)) continue
				const role = String(asRecord(messages[ordinal])?.role ?? "unknown")
				const text = messageToText(messages[ordinal]).trim()
				if (!text) continue
				const entry = `#${ordinal} ${role}:\n${text}`
				if (used + entry.length > maxChars) {
					if (picked.size === 0) {
						picked.set(ordinal, `${entry.slice(0, maxChars)}…`)
						used = maxChars
					}
					continue
				}
				picked.set(ordinal, entry)
				used += entry.length
				added = true
			}
			if (!added && used >= maxChars) break
		}
		const ordered = [...picked.entries()].sort(([a], [b]) => a - b)
		const first = ordered[0]?.[0] ?? 0
		const last = ordered[ordered.length - 1]?.[0] ?? 0
		const header = `Conversation ${sessionId}: messages ${first}–${last} of ${messages.length - 1}.`
		return [header, ...ordered.map(([, text]) => text)].join("\n\n")
	}

	async dispose(): Promise<void> {
		const index = this.index
		this.index = undefined
		await index?.dispose().catch(() => {})
	}

	/** The index, started on first use and refreshed before each search for at most `readyTimeoutMs`. */
	private async readyIndex(): Promise<ConversationIndex | undefined> {
		if (!this.index) {
			try {
				this.index = this.options.createIndex({
					// The index asks for up to 100,000; listing that many records is too slow for an extension host.
					listSessions: (limit) =>
						this.options.source.listSessions(Math.min(limit ?? MAX_INDEXED_SESSIONS, MAX_INDEXED_SESSIONS)),
					readSessionMessages: (sessionId) => this.options.source.readMessages(sessionId),
				})
				this.index.start()
			} catch (error) {
				Logger.warn("[Memory] The conversation search index could not be created:", error)
				return undefined
			}
		}
		if (!this.index.isAvailable()) {
			return undefined
		}
		const timeout = new Promise<void>((resolve) => setTimeout(resolve, this.options.readyTimeoutMs ?? 8000).unref?.())
		await Promise.race([this.index.refreshNow().catch(() => {}), timeout])
		return this.index
	}

	/** Without the index: every word must appear in a message of one of the most recent conversations. */
	private async scan(query: string, keep: (hit: IndexHit) => boolean): Promise<IndexHit[]> {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean)
		if (words.length === 0) return []
		const sessions = await this.options.source.listSessions(FALLBACK_SCAN_SESSIONS)
		const hits: IndexHit[] = []
		for (const session of sessions) {
			const base = {
				sessionId: session.sessionId,
				startedAt: session.startedAt,
				workspaceRoot: session.workspaceRoot,
				title: titleOf(session),
			}
			if (!keep({ ...base, ordinal: -1, role: "session", snippet: "" })) continue
			const messages = await this.options.source.readMessages(session.sessionId).catch(() => [] as unknown[])
			const hidden = offTheRecordMessageIndices(messages as Parameters<typeof offTheRecordMessageIndices>[0])
			for (const [ordinal, message] of messages.entries()) {
				if (hidden.has(ordinal)) continue
				const text = messageToText(message)
				const lower = text.toLowerCase()
				if (!words.every((word) => lower.includes(word))) continue
				const at = lower.indexOf(words[0])
				const start = Math.max(0, at - SNIPPET_RADIUS)
				const snippet = `${start > 0 ? "…" : ""}${text
					.slice(start, at + SNIPPET_RADIUS)
					.replace(/\s+/g, " ")
					.trim()}…`
				hits.push({ ...base, ordinal, role: String(asRecord(message)?.role ?? "unknown"), snippet })
				break
			}
		}
		return hits
	}
}
