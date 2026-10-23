// One memory section per conversation, like the git snapshot
// (context/conversation-git-snapshots.ts).
//
// The memory files are read when a conversation's first session config is
// built, and every later build of that conversation (mode switch, MCP change,
// resume, compaction) gets the same section, so the system prompt's cached
// prefix survives. A memory saved during the conversation is already in its
// transcript, so the model does not need it in the prompt as well.
//
// Unlike the git snapshot, the section is only kept in memory: it can be a
// few thousand tokens, and session metadata is read for every row of the
// history list. A conversation resumed after a window restart reads the
// files again, which costs one cache miss.

import { Logger } from "@/shared/services/Logger"
import { type MemorySelection, selectMemories } from "./memory-retrieval"
import type { MemorySectionSummary } from "./memory-section"
import type { MemoryContents } from "./memory-store"

const MAX_REMEMBERED_CONVERSATIONS = 100

interface ConversationMemorySnapshotsOptions {
	/** `plinycode.memory.maxTokens`, read on every build. 0 turns memory off. */
	getMaxTokens: (contextWindow?: number) => number
	getUserShare?: () => number
	read: (cwd: string) => Promise<MemoryContents>
}

interface PreparedMemorySection {
	/** What the system prompt gets; undefined when memory is off or could not be read. */
	section: string | undefined
	summary: MemorySectionSummary | undefined
	bindToSession: (sessionId: string) => void
}

export class ConversationMemorySnapshots {
	private readonly bySession = new Map<string, MemorySelection | null>()

	constructor(private readonly options: ConversationMemorySnapshotsOptions) {}

	/**
	 * `conversationId` is the conversation the config continues; undefined for
	 * a new one. Either way the files are read only when this window has no
	 * section for the conversation yet.
	 */
	async prepare(conversationId: string | undefined, cwd: string, contextWindow?: number): Promise<PreparedMemorySection> {
		const maxTokens = this.maxTokens(contextWindow)
		let rendered = conversationId ? this.bySession.get(conversationId) : undefined
		if (!(maxTokens > 0)) {
			rendered = null
			if (conversationId) this.remember(conversationId, null)
		}
		if (rendered === undefined || (rendered === null && maxTokens > 0)) {
			rendered = maxTokens > 0 ? await this.capture(cwd, maxTokens) : null
			if (conversationId) {
				this.remember(conversationId, rendered)
			}
		}
		if (rendered && rendered.budget !== maxTokens) {
			rendered = selectMemories(rendered.source, maxTokens, undefined, {}, this.options.getUserShare?.() ?? 25)
			if (conversationId) this.remember(conversationId, rendered)
		}
		const shown = maxTokens > 0 ? (rendered ?? undefined) : undefined
		return {
			section: shown?.text,
			summary: shown?.summary,
			bindToSession: (sessionId) => this.remember(sessionId, rendered ?? null),
		}
	}

	get(sessionId: string): MemorySelection | undefined {
		return this.bySession.get(sessionId) ?? undefined
	}

	retrieve(
		sessionId: string,
		query: string,
		usage: Record<string, { count?: number; used?: string }> = {},
	): MemorySelection | undefined {
		const captured = this.get(sessionId)
		if (!captured || captured.retrieved) return captured
		const selected = selectMemories(captured.source, captured.budget, query, usage, captured.userShare)
		this.remember(sessionId, selected)
		return selected
	}

	private maxTokens(contextWindow?: number): number {
		try {
			return this.options.getMaxTokens(contextWindow)
		} catch {
			return 0
		}
	}

	private async capture(cwd: string, maxTokens: number): Promise<MemorySelection | null> {
		try {
			return selectMemories(await this.options.read(cwd), maxTokens, undefined, {}, this.options.getUserShare?.() ?? 25)
		} catch (error) {
			Logger.debug("[Memory] Failed to read the memory files:", error)
			return null
		}
	}

	private remember(sessionId: string, rendered: MemorySelection | null): void {
		this.bySession.delete(sessionId)
		this.bySession.set(sessionId, rendered)
		if (this.bySession.size > MAX_REMEMBERED_CONVERSATIONS) {
			const oldest = this.bySession.keys().next().value
			if (oldest !== undefined) this.bySession.delete(oldest)
		}
	}
}
