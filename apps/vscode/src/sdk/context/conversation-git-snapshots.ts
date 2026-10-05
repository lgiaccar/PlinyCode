// One git snapshot per conversation.
//
// The system prompt is rebuilt many times in a conversation's life: on a mode
// switch, when MCP tools change, on every resume. A snapshot gathered again on
// each rebuild would change the prompt's prefix and throw away the provider's
// prompt cache, and it would no longer be "the state when the conversation
// started". So the snapshot is gathered once, when the conversation's first
// session config is built, and every later build gets that same one:
//
// - from memory while the window lives;
// - from the session record's metadata after a restart or in another window.
//   SdkSessionLifecycle writes it there with every session start, so the
//   engine persists it together with the record itself.
//
// A conversation that started without a snapshot (not a git repository, the
// setting off, or begun before this existed) never gets one later.

import type { GitSnapshot } from "@plinycode/shared"
import { Logger } from "@/shared/services/Logger"

/** Session metadata key the snapshot is stored under. */
export const GIT_SNAPSHOT_METADATA_KEY = "gitSnapshot"

// Conversations whose snapshot stays in memory. Older ones are read back from
// their session record when they are next rebuilt.
const MAX_REMEMBERED_CONVERSATIONS = 100

export interface ConversationGitSnapshotsOptions {
	/** `plinycode.context.gitSnapshot`, read on every build so a change applies to the next one. */
	isEnabled: () => boolean
	gather: (cwd: string) => Promise<GitSnapshot | undefined>
	/** The value stored under GIT_SNAPSHOT_METADATA_KEY in the conversation's session record. */
	readStored: (conversationId: string) => Promise<unknown>
}

export interface PreparedGitSnapshot {
	/** What the system prompt shows; undefined when there is none or the setting is off. */
	snapshot: GitSnapshot | undefined
	/**
	 * Ties the conversation's snapshot to the session the config is built for.
	 * A new conversation only learns its session id after the config is built,
	 * and editing a message continues the conversation under a new id.
	 */
	bindToSession: (sessionId: string) => void
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined
}

/** Reads a snapshot back from session metadata, dropping anything that is not the expected shape. */
export function parseStoredGitSnapshot(value: unknown): GitSnapshot | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined
	}
	const stored = value as Record<string, unknown>
	const text = (key: string) => (typeof stored[key] === "string" && stored[key] ? (stored[key] as string) : undefined)
	const snapshot: GitSnapshot = {}
	const branch = text("branch")
	const head = text("head")
	const defaultBranch = text("defaultBranch")
	const status = stringList(stored.status)
	const recentCommits = stringList(stored.recentCommits)
	if (branch) snapshot.branch = branch
	if (head) snapshot.head = head
	if (defaultBranch) snapshot.defaultBranch = defaultBranch
	if (status) snapshot.status = status
	if (typeof stored.statusOmitted === "number" && stored.statusOmitted > 0) snapshot.statusOmitted = stored.statusOmitted
	if (stored.statusIncomplete === true) snapshot.statusIncomplete = true
	if (recentCommits?.length) snapshot.recentCommits = recentCommits
	return Object.keys(snapshot).length > 0 ? snapshot : undefined
}

export class ConversationGitSnapshots {
	// null: the conversation is known to have no snapshot.
	private readonly bySession = new Map<string, GitSnapshot | null>()

	constructor(private readonly options: ConversationGitSnapshotsOptions) {}

	/**
	 * Resolves the snapshot for a session config that is about to be built.
	 * `conversationId` is the conversation the config continues; undefined
	 * means a new conversation, which is the only case that runs git.
	 */
	async prepare(conversationId: string | undefined, cwd: string): Promise<PreparedGitSnapshot> {
		const enabled = this.isEnabled()
		let snapshot: GitSnapshot | null
		if (conversationId) {
			snapshot = await this.recall(conversationId)
		} else {
			snapshot = enabled ? await this.capture(cwd) : null
		}
		return {
			// A snapshot the conversation already has is kept while the setting
			// is off, so turning it back on shows the original one again.
			snapshot: enabled ? (snapshot ?? undefined) : undefined,
			bindToSession: (sessionId) => this.remember(sessionId, snapshot),
		}
	}

	/** The metadata to store with the session's record, if the conversation has a snapshot. */
	sessionMetadata(sessionId: string | undefined): Record<string, unknown> | undefined {
		const snapshot = sessionId ? this.bySession.get(sessionId) : undefined
		return snapshot ? { [GIT_SNAPSHOT_METADATA_KEY]: snapshot } : undefined
	}

	private isEnabled(): boolean {
		try {
			return this.options.isEnabled()
		} catch {
			return false
		}
	}

	private async capture(cwd: string): Promise<GitSnapshot | null> {
		try {
			return (await this.options.gather(cwd)) ?? null
		} catch (error) {
			Logger.debug("[GitSnapshot] Failed to gather the git snapshot:", error)
			return null
		}
	}

	private async recall(conversationId: string): Promise<GitSnapshot | null> {
		const remembered = this.bySession.get(conversationId)
		if (remembered !== undefined) {
			return remembered
		}
		try {
			const stored = parseStoredGitSnapshot(await this.options.readStored(conversationId)) ?? null
			this.remember(conversationId, stored)
			return stored
		} catch (error) {
			// Not remembered: the next build reads the record again.
			Logger.debug(`[GitSnapshot] Failed to read the stored snapshot of ${conversationId}:`, error)
			return null
		}
	}

	private remember(sessionId: string, snapshot: GitSnapshot | null): void {
		const id = sessionId.trim()
		if (!id) {
			return
		}
		// Re-inserting moves the entry to the end, so eviction drops the least recently built.
		this.bySession.delete(id)
		this.bySession.set(id, snapshot)
		while (this.bySession.size > MAX_REMEMBERED_CONVERSATIONS) {
			const oldest = this.bySession.keys().next().value
			if (oldest === undefined) {
				break
			}
			this.bySession.delete(oldest)
		}
	}
}
