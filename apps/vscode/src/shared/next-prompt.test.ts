import { describe, expect, it } from "vitest"
import type { ClineMessage, TurnPhase } from "./ExtensionMessage"
import { nextPromptCompletion } from "./next-prompt"

const complete: ClineMessage = { ts: 1, type: "say", say: "completion_result", text: "Done" }
describe("next prompt completion eligibility", () => {
	it.each(["completed", "awaiting_followup"] as TurnPhase[])("accepts a clean result in %s", (phase) =>
		expect(nextPromptCompletion([complete], phase)).toBe(complete))
	it.each(["streaming", "awaiting_approval", "resumable", "error", "idle"] as TurnPhase[])("does not suggest in %s", (phase) =>
		expect(nextPromptCompletion([complete], phase)).toBeUndefined())
	it("rejects an older completion after a new question or turn", () => {
		for (const next of [
			{ ts: 2, type: "ask", ask: "followup" },
			{ ts: 2, type: "say", say: "user_feedback" },
			{ ts: 2, type: "say", say: "text" },
		] as ClineMessage[])
			expect(nextPromptCompletion([complete, next], "awaiting_followup")).toBeUndefined()
	})
	it("allows trailing metadata and reopening, but never partial text", () => {
		expect(
			nextPromptCompletion(
				[complete, { ts: 2, type: "say", say: "api_req_started" }, { ts: 3, type: "ask", ask: "resume_completed_task" }],
				"completed",
			),
		).toBe(complete)
		expect(nextPromptCompletion([{ ...complete, partial: true }], "completed")).toBeUndefined()
	})
})
