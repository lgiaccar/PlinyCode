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
import { type MemorySectionSummary, type RenderedMemorySection, renderMemorySection } from "./memory-section"
import type { MemoryContents } from "./memory-store"

const MAX_REMEMBERED_CONVERSATIONS = 100

interface ConversationMemorySnapshotsOptions {
	/** `plinycode.memory.maxTokens`, read on every build. 0 turns memory off. */
	getMaxTokens: () => number
	read: (cwd: string) => Promise<MemoryContents>
}

interface PreparedMemorySection {
	/** What the system prompt gets; undefined when memory is off or could not be read. */
	section: string | undefined
	summary: MemorySectionSummary | undefined
	bindToSession: (sessionId: string) => void
}

export class ConversationMemorySnapshots {
	private readonly bySession = new Map<string, RenderedMemorySection | null>()

	constructor(private readonly options: ConversationMemorySnapshotsOptions) {}

	/**
	 * `conversationId` is the conversation the config continues; undefined for
	 * a new one. Either way the files are read only when this window has no
	 * section for the conversation yet.
	 */
	async prepare(conversationId: string | undefined, cwd: string): Promise<PreparedMemorySection> {
		const maxTokens = this.maxTokens()
		let rendered = conversationId ? this.bySession.get(conversationId) : undefined
		if (rendered === undefined) {
			rendered = maxTokens > 0 ? await this.capture(cwd, maxTokens) : null
			if (conversationId) {
				this.remember(conversationId, rendered)
			}
		}
		const shown = maxTokens > 0 ? (rendered ?? undefined) : undefined
		return {
			section: shown?.text,
			summary: shown?.summary,
			bindToSession: (sessionId) => this.remember(sessionId, rendered ?? null),
		}
	}

	private maxTokens(): number {
		try {
			return this.options.getMaxTokens()
		} catch {
			return 0
		}
	}

	private async capture(cwd: string, maxTokens: number): Promise<RenderedMemorySection | null> {
		try {
			return renderMemorySection(await this.options.read(cwd), maxTokens) ?? null
		} catch (error) {
			Logger.debug("[Memory] Failed to read the memory files:", error)
			return null
		}
	}

	private remember(sessionId: string, rendered: RenderedMemorySection | null): void {
		this.bySession.delete(sessionId)
		this.bySession.set(sessionId, rendered)
		if (this.bySession.size > MAX_REMEMBERED_CONVERSATIONS) {
			const oldest = this.bySession.keys().next().value
			if (oldest !== undefined) this.bySession.delete(oldest)
		}
	}
}
