import type { AttentionStatus } from "@shared/attention"
import type { TurnPhase } from "@shared/ExtensionMessage"

/** Live approval/question state takes priority over an older persisted completion. */
export function attentionStatus(input: {
	phase?: TurnPhase
	background?: "running" | "needs_attention"
	persisted: string
	updatedAt: number
	reviewedAt?: number
}): AttentionStatus | undefined {
	if (input.phase === "awaiting_approval") return "approval"
	if (input.phase === "awaiting_followup") return "question"
	if (input.background === "needs_attention") return "attention"
	if (input.phase === "streaming" || input.background === "running") return "running"
	if (input.phase === "error" || input.persisted === "failed") return "error"
	if (input.phase === "resumable" || input.persisted === "cancelled") return "attention"
	if (input.phase === "completed" || input.persisted === "completed" || input.persisted === "idle") {
		return input.reviewedAt === input.updatedAt ? "reviewed" : "review"
	}
	return undefined
}
