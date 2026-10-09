// One prompt date per conversation.
//
// The system prompt's <env> block shows the date near the top of the prompt.
// Filling it in from the clock on every rebuild (mode switch, MCP change,
// resume, compaction) changes the prompt's prefix the first time a
// conversation is rebuilt on a later day and throws away the provider's
// prompt cache, exactly what pinning the git snapshot avoids
// (conversation-git-snapshots.ts). So the date is fixed when the
// conversation's first session config is built and every later build gets
// the same one: from memory while the window lives, and from the session
// record's metadata after a restart or in another window. SdkSessionLifecycle
// writes it there with every session start.
//
// The editor state sent with each message, and the model's own tool calls,
// are where the current day shows up when it matters.

import { Logger } from "@/shared/services/Logger"

/** Session metadata key the date is stored under. */
export const PROMPT_DATE_METADATA_KEY = "promptDate"

// Conversations whose date stays in memory. Older ones are read back from
// their session record when they are next rebuilt.
const MAX_REMEMBERED_CONVERSATIONS = 100

export interface ConversationPromptDatesOptions {
	/** Today, formatted the way the prompt shows it. */
	today: () => string
	/** The value stored under PROMPT_DATE_METADATA_KEY in the conversation's session record. */
	readStored: (conversationId: string) => Promise<unknown>
}

export interface PreparedPromptDate {
	/** The date the system prompt shows for this conversation. */
	date: string
	/** Ties the date to the session the config is built for, like the git snapshot. */
	bindToSession: (sessionId: string) => void
}

export class ConversationPromptDates {
	private readonly bySession = new Map<string, string>()

	constructor(private readonly options: ConversationPromptDatesOptions) {}

	/**
	 * Resolves the date for a session config that is about to be built.
	 * `conversationId` is the conversation the config continues; undefined
	 * means a new conversation, which gets today's date.
	 */
	async prepare(conversationId: string | undefined): Promise<PreparedPromptDate> {
		const date = (conversationId ? await this.recall(conversationId) : undefined) ?? this.options.today()
		return {
			date,
			bindToSession: (sessionId) => this.remember(sessionId, date),
		}
	}

	/** The metadata to store with the session's record. */
	sessionMetadata(sessionId: string | undefined): Record<string, unknown> | undefined {
		const date = sessionId ? this.bySession.get(sessionId) : undefined
		return date ? { [PROMPT_DATE_METADATA_KEY]: date } : undefined
	}

	private async recall(conversationId: string): Promise<string | undefined> {
		const remembered = this.bySession.get(conversationId)
		if (remembered !== undefined) {
			return remembered
		}
		try {
			const stored = await this.options.readStored(conversationId)
			const date = typeof stored === "string" && stored.trim() ? stored.trim() : undefined
			if (date) {
				this.remember(conversationId, date)
			}
			return date
		} catch (error) {
			// A conversation started before the date was stored gets today's; that
			// is one cache miss, the same as before pinning existed.
			Logger.debug(`[PromptDate] Failed to read the stored date of ${conversationId}:`, error)
			return undefined
		}
	}

	private remember(sessionId: string, date: string): void {
		const id = sessionId.trim()
		if (!id) {
			return
		}
		this.bySession.delete(id)
		this.bySession.set(id, date)
		while (this.bySession.size > MAX_REMEMBERED_CONVERSATIONS) {
			const oldest = this.bySession.keys().next().value
			if (oldest === undefined) {
				break
			}
			this.bySession.delete(oldest)
		}
	}
}
