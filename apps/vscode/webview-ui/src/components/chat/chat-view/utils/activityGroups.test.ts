import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { groupActivityRows, isActivityGroup } from "./activityGroups"

const say = (ts: number, kind: ClineMessage["say"], text = ""): ClineMessage => ({
	ts,
	type: "say",
	say: kind,
	text,
})

describe("groupActivityRows", () => {
	it("shows the final answer and groups the preceding reasoning and tools", () => {
		const reasoning = say(2, "reasoning", "Planning")
		const tool = say(3, "tool", "Search")
		const toolGroup = [tool] as ClineMessage[] & { _isToolGroup: true }
		toolGroup._isToolGroup = true
		const answer = say(4, "completion_result", "Final answer")
		const result = groupActivityRows([reasoning, toolGroup, answer])
		expect(result).toHaveLength(2)
		expect(isActivityGroup(result[0])).toBe(true)
		if (isActivityGroup(result[0])) {
			expect(Array.from(result[0])).toEqual([reasoning, tool])
			expect(result[0].items).toEqual([reasoning, toolGroup])
		}
		expect(result[1]).toBe(answer)
	})

	it("keeps each real user prompt and its final text in a separate turn", () => {
		const firstPrompt = say(1, "task", "First")
		const secondPrompt = say(4, "user_feedback", "Second")
		const result = groupActivityRows([
			firstPrompt,
			say(2, "reasoning"),
			say(3, "text", "First answer"),
			secondPrompt,
			say(5, "tool"),
			say(6, "text", "Second answer"),
		])
		expect(result.map((item) => (Array.isArray(item) ? "activity" : item.say))).toEqual([
			"task",
			"activity",
			"text",
			"user_feedback",
			"activity",
			"text",
		])
	})

	it("keeps a CI watcher report and both surrounding answers visible", () => {
		const firstAnswer = say(2, "text", "First answer")
		const report = say(3, "user_feedback", "[CI WATCHER] passed")
		const secondAnswer = say(4, "text", "Second answer")
		expect(groupActivityRows([firstAnswer, report, secondAnswer])).toEqual([firstAnswer, report, secondAnswer])
	})

	it("keeps a pending approval visible and includes tool feedback in activity", () => {
		const approval: ClineMessage = { ts: 2, type: "ask", ask: "tool", text: "Approve?" }
		expect(groupActivityRows([say(1, "reasoning"), approval]).at(-1)).toBe(approval)
		const feedback = { ...say(3, "user_feedback", "Approved"), answersTool: true }
		const result = groupActivityRows([say(1, "reasoning"), approval, feedback, say(4, "completion_result", "Done")])
		expect(result).toHaveLength(4)
		expect(isActivityGroup(result[0])).toBe(true)
		expect(result[1]).toBe(approval)
		expect(isActivityGroup(result[2])).toBe(true)
	})

	it.each([
		"editedExistingFile",
		"newFileCreated",
	] as const)("groups automatic %s activity but keeps approval requests visible", (tool) => {
		const edit = say(2, "tool", JSON.stringify({ tool, path: "test.ts", content: 'export const name = "cline"' }))
		const answer = say(3, "completion_result", "Done")
		const result = groupActivityRows([say(1, "reasoning"), edit, answer])
		expect(result).toHaveLength(2)
		expect(isActivityGroup(result[0])).toBe(true)
		if (isActivityGroup(result[0])) {
			expect(result[0].items).toContain(edit)
		}
		expect(result[1]).toBe(answer)

		const approval: ClineMessage = { ts: edit.ts, type: "ask", ask: "tool", text: edit.text }
		const pending = groupActivityRows([say(1, "reasoning"), approval])
		expect(pending.at(-1)).toBe(approval)
	})

	it("keeps all adjacent final text blocks visible when there is no completion row", () => {
		const first = say(3, "text", "First paragraph")
		const second = say(4, "text", "Second paragraph")
		const result = groupActivityRows([say(1, "reasoning"), say(2, "tool"), first, second])
		expect(result.slice(1)).toEqual([first, second])
	})

	it("treats text before an unfinished tool call as activity", () => {
		const result = groupActivityRows([say(1, "text", "I will search"), say(2, "tool", "Searching")])
		expect(result).toHaveLength(1)
		expect(isActivityGroup(result[0])).toBe(true)
	})

	it("leaves errors and actionable memory proposals visible", () => {
		const error = say(2, "error", "Failed")
		const memory = say(3, "memory_proposal", "Remember this")
		const result = groupActivityRows([say(1, "reasoning"), error, memory])
		expect(result.slice(1)).toEqual([error, memory])
	})
})
