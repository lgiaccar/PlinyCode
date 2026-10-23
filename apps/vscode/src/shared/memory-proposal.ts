// The `memory_proposal` chat row: memories distilled from a conversation,
// offered for the user to save, and stale entries offered for removal
// (docs/memory.md). The row's text is this
// object as JSON; the webview renders it with checkboxes and sends the choice
// back through TaskService.resolveMemoryProposal.

import type { MemoryScope, MemoryType } from "./memory"

export type MemoryProposalStatus = "pending" | "saving" | "saved" | "dismissed" | "empty"

export interface MemoryProposalItem {
	id: string
	scope: MemoryScope
	type?: MemoryType
	details?: string
	autoSaved?: boolean
	text: string
	importance: "high" | "normal"
	/**
	 * "remove": a prune proposal for an entry not used for 90 days, or for an
	 * orphaned topic file (`topicFile`). Absent for a memory to save.
	 */
	action?: "remove"
	/**
	 * Why a removal is proposed: not used for 90 days (absent or "stale"), a
	 * record of what a task changed, or a near duplicate of another entry.
	 */
	reason?: "stale" | "change-log" | "duplicate"
	/** For a topic file removal: the file's name in the scope's memory folder. */
	topicFile?: string
}

export interface MemoryProposal {
	createdAt?: number
	id: string
	conversationId: string
	status: MemoryProposalStatus
	items: MemoryProposalItem[]
	/** The repository the repo-scoped items go to, for the row's label. */
	repo?: string
	/** After saving: how many items were saved. */
	savedCount?: number
	/** After saving: how many removal items were removed. */
	removedCount?: number
	error?: string
}

export function parseMemoryProposal(text: string | undefined): MemoryProposal | undefined {
	if (!text) {
		return undefined
	}
	try {
		const parsed = JSON.parse(text) as MemoryProposal
		if (
			!parsed ||
			typeof parsed.id !== "string" ||
			typeof parsed.conversationId !== "string" ||
			!["pending", "saving", "saved", "dismissed", "empty"].includes(parsed.status) ||
			!Array.isArray(parsed.items)
		)
			return undefined
		if (
			!parsed.items.every(
				(item) =>
					item &&
					typeof item.id === "string" &&
					typeof item.text === "string" &&
					["repo", "group", "user"].includes(item.scope) &&
					["high", "normal"].includes(item.importance) &&
					(item.details === undefined || typeof item.details === "string"),
			)
		)
			return undefined
		return parsed
	} catch {
		return undefined
	}
}
