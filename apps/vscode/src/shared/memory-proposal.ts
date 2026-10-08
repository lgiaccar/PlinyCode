// The `memory_proposal` chat row: memories distilled from a conversation,
// offered for the user to save (docs/memory.md). The row's text is this
// object as JSON; the webview renders it with checkboxes and sends the choice
// back through TaskService.resolveMemoryProposal.

export type MemoryProposalStatus = "pending" | "saving" | "saved" | "dismissed" | "empty"

export interface MemoryProposalItem {
	id: string
	scope: "repo" | "user"
	text: string
	importance: "high" | "normal"
}

export interface MemoryProposal {
	id: string
	conversationId: string
	status: MemoryProposalStatus
	items: MemoryProposalItem[]
	/** The repository the repo-scoped items go to, for the row's label. */
	repo?: string
	/** After saving: how many items were saved. */
	savedCount?: number
	error?: string
}

export function parseMemoryProposal(text: string | undefined): MemoryProposal | undefined {
	if (!text) {
		return undefined
	}
	try {
		const parsed = JSON.parse(text) as MemoryProposal
		return parsed && typeof parsed.id === "string" && Array.isArray(parsed.items) ? parsed : undefined
	} catch {
		return undefined
	}
}
