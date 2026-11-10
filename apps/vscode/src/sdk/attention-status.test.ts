import { expect, it } from "vitest"
import { attentionStatus } from "./attention-status"

it("does not hide a live approval behind reviewed persisted status", () => {
	expect(attentionStatus({ phase: "awaiting_approval", persisted: "completed", updatedAt: 5, reviewedAt: 5 })).toBe("approval")
	expect(attentionStatus({ background: "needs_attention", persisted: "idle", updatedAt: 5 })).toBe("attention")
})
it("requires a new review after task activity and distinguishes failed runs", () => {
	expect(attentionStatus({ persisted: "completed", updatedAt: 6, reviewedAt: 5 })).toBe("review")
	expect(attentionStatus({ persisted: "completed", updatedAt: 5, reviewedAt: 5 })).toBe("reviewed")
	expect(attentionStatus({ persisted: "failed", updatedAt: 5 })).toBe("error")
	expect(attentionStatus({ persisted: "running", updatedAt: 5 })).toBeUndefined()
})
