import { describe, expect, it } from "vitest"
import type { ScheduledPrompt } from "../components/layout/ScheduledPrompts"
import { bindScheduledPromptsToTask, takeDueScheduledPrompts } from "./scheduledPrompts"

const prompt = (overrides: Partial<ScheduledPrompt>): ScheduledPrompt => ({
	id: "p",
	text: "hello",
	images: [],
	files: [],
	scheduledAt: 1000,
	...overrides,
})

describe("takeDueScheduledPrompts", () => {
	it("sends a due prompt only in the conversation it was scheduled in", () => {
		const scheduled = [prompt({ id: "a", taskId: "task-a" })]

		const inB = takeDueScheduledPrompts(scheduled, 2000, "task-b")
		expect(inB.due).toEqual([])
		expect(inB.rest).toEqual(scheduled)

		const inA = takeDueScheduledPrompts(scheduled, 2000, "task-a")
		expect(inA.due.map((p) => p.id)).toEqual(["a"])
		expect(inA.rest).toEqual([])
	})

	it("keeps prompts scheduled on the welcome screen out of conversations", () => {
		const scheduled = [prompt({ id: "welcome" })]
		expect(takeDueScheduledPrompts(scheduled, 2000, "task-a").due).toEqual([])
		expect(takeDueScheduledPrompts(scheduled, 2000, undefined).due.map((p) => p.id)).toEqual(["welcome"])
	})

	it("moves a repeating prompt on one interval past now", () => {
		const scheduled = [prompt({ taskId: "task-a", remaining: 3, intervalMs: 500 })]
		const { due, rest } = takeDueScheduledPrompts(scheduled, 2200, "task-a")
		expect(due).toHaveLength(1)
		expect(rest).toEqual([expect.objectContaining({ remaining: 2, scheduledAt: 2500, taskId: "task-a" })])
	})

	it("binds the repeats of a welcome-screen prompt to the conversation it starts", () => {
		const { rest } = takeDueScheduledPrompts([prompt({ remaining: 2, intervalMs: 500 })], 1000, undefined)
		expect(rest[0].bindToNextTask).toBe(true)

		const bound = bindScheduledPromptsToTask(rest, "task-new")
		expect(bound[0].taskId).toBe("task-new")
		expect(bound[0].bindToNextTask).toBeUndefined()
	})
})
