import { describe, expect, it } from "vitest"
import {
	ACT_MODE_CONTINUATION_PROMPT,
	extractSdkUserText,
	isSyntheticSdkUserMessage,
	isSyntheticUserPrompt,
	planEditRestart,
} from "./sdk-user-message-mapping"

// Persisted prompts are wrapped by formatModePrompt before they reach SDK
// history; the mapping must recognize the wrapped shape, not just raw text.
const wrapped = (text: string, mode = "act") => `<user_input mode="${mode}">${text}</user_input>`

describe("isSyntheticUserPrompt", () => {
	it("flags task resumption and act-mode continuation prompts", () => {
		expect(isSyntheticUserPrompt("[TASK RESUMPTION] Please continue where you left off.")).toBe(true)
		expect(isSyntheticUserPrompt(ACT_MODE_CONTINUATION_PROMPT)).toBe(true)
	})

	it("flags the wrapped persisted shape of synthetic prompts", () => {
		expect(isSyntheticUserPrompt(wrapped(ACT_MODE_CONTINUATION_PROMPT))).toBe(true)
		expect(isSyntheticUserPrompt(wrapped("[TASK RESUMPTION] Please continue where you left off.", "plan"))).toBe(true)
	})

	it("does not flag ordinary user messages, wrapped or raw", () => {
		expect(isSyntheticUserPrompt("make a plan for the auth refactor")).toBe(false)
		expect(isSyntheticUserPrompt(wrapped("go ahead and implement step 1"))).toBe(false)
	})

	it("flags hook-injected context blocks", () => {
		expect(isSyntheticUserPrompt('<hook_context source="PreToolUse" tool_name="read_files">\nNOTE\n</hook_context>')).toBe(
			true,
		)
	})

	it("flags synthetic prompts that carry a mode-switch notice", () => {
		// A user-initiated plan -> act toggle stamps a <mode_notice> onto the
		// canned continuation; the notice must not make the synthetic prompt
		// count as a visible user message or every later edit/regenerate
		// ordinal shifts by one.
		const notice = "<mode_notice>The user switched from plan mode to act mode before sending this message.</mode_notice>"
		expect(isSyntheticUserPrompt(`${notice}\n${ACT_MODE_CONTINUATION_PROMPT}`)).toBe(true)
		expect(isSyntheticUserPrompt(wrapped(`${notice}\n${ACT_MODE_CONTINUATION_PROMPT}`))).toBe(true)
		expect(isSyntheticUserPrompt(`${notice}\ngo ahead and implement step 1`)).toBe(false)
	})
})

describe("isSyntheticSdkUserMessage", () => {
	it("flags messages stamped with a system display role", () => {
		expect(
			isSyntheticSdkUserMessage({
				role: "user",
				content: [{ type: "text", text: "compaction summary or hook context" }],
				metadata: { displayRole: "system", userRunSpan: 0 },
			}),
		).toBe(true)
	})

	it("does not flag ordinary user messages", () => {
		expect(
			isSyntheticSdkUserMessage({
				role: "user",
				content: [{ type: "text", text: wrapped("fix the bug") }],
				metadata: { userRunSpan: 1 },
			}),
		).toBe(false)
	})
})

describe("planEditRestart: prompt rows", () => {
	const cutIndex = (messages: Array<{ role: string; content: unknown }>, promptOrdinal: number) =>
		planEditRestart(messages, { isAnswer: false, promptOrdinal, answerOccurrence: 0 })?.initialMessages.length ?? -1
	const user = (text: string) => ({ role: "user", content: text })
	const assistant = (text: string) => ({ role: "assistant", content: text })

	it("maps visible ordinals one to one when no synthetic prompts exist", () => {
		const messages = [user("task"), assistant("plan"), user("follow-up")]

		expect(cutIndex(messages, 1)).toBe(0)
		expect(cutIndex(messages, 2)).toBe(2)
	})

	it("skips the hidden act-mode continuation prompt as persisted", () => {
		// Plan task, plan presented, empty-composer toggle to act (hidden canned
		// prompt in SDK history, no visible user_feedback), act work, follow-up.
		// Persisted prompts carry the formatModePrompt wrapper.
		const messages = [
			user(wrapped("plan the auth refactor", "plan")),
			assistant("here is the plan"),
			user(wrapped(ACT_MODE_CONTINUATION_PROMPT)),
			assistant("done with step 1"),
			user(wrapped("now do step 2")),
		]

		// The visible transcript has 2 user messages; the 2nd must map past the
		// hidden continuation to index 4, not index 2.
		expect(cutIndex(messages, 2)).toBe(4)
	})

	it("skips task resumption prompts as persisted", () => {
		const messages = [
			user(wrapped("original task")),
			assistant("partial work"),
			user(wrapped("[TASK RESUMPTION] Please continue where you left off.")),
			assistant("resumed work"),
			user(wrapped("looks good, keep going")),
		]

		expect(cutIndex(messages, 2)).toBe(4)
	})

	it("returns -1 when the ordinal exceeds the visible user messages", () => {
		const messages = [user("task"), user(ACT_MODE_CONTINUATION_PROMPT)]

		expect(cutIndex(messages, 2)).toBe(-1)
	})

	it("counts an attachment-only continuation because it has a visible bubble", () => {
		// Attachment-only plan -> act toggle: the SDK message carries the canned
		// prompt text plus the user's image, and the webview shows a user_feedback
		// bubble for the attachment, so the message must be counted.
		const messages = [
			user(wrapped("plan the auth refactor", "plan")),
			assistant("here is the plan"),
			{
				role: "user",
				content: [
					{ type: "text", text: wrapped(ACT_MODE_CONTINUATION_PROMPT) },
					{ type: "image", mediaType: "image/png", data: "abc" },
				],
			},
			assistant("done with step 1"),
			user(wrapped("now do step 2")),
		]

		expect(cutIndex(messages, 2)).toBe(2)
		expect(cutIndex(messages, 3)).toBe(4)
	})

	it("counts attachment-only user messages with no text", () => {
		const messages = [
			user("task"),
			{
				role: "user",
				content: [{ type: "image", mediaType: "image/png", data: "abc" }],
			},
		]

		expect(cutIndex(messages, 2)).toBe(1)
	})

	it("does not count tool results even when they carry media blocks", () => {
		const messages = [
			user("task"),
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "t1" },
					{ type: "image", mediaType: "image/png", data: "screenshot" },
				],
			},
			user("follow-up"),
		]

		expect(cutIndex(messages, 2)).toBe(2)
	})
})

describe("planEditRestart: answers and checkpoints", () => {
	const user = (text: string) => ({ role: "user", content: wrapped(text) })
	const assistant = (text: string) => ({ role: "assistant", content: text })
	const askQuestion = (id: string) => ({
		role: "assistant",
		content: [{ type: "tool_use", id, name: "ask_question", input: { question: "Which one?" } }],
	})
	const answer = (id: string, text: string) => ({
		role: "user",
		content: [{ type: "tool_result", tool_use_id: id, name: "ask_question", content: text }],
	})
	const toolCall = (id: string, name = "read_files") => ({
		role: "assistant",
		content: [{ type: "tool_use", id, name, input: {} }],
	})
	const toolResult = (id: string, content = "ok") => ({
		role: "user",
		content: [{ type: "tool_result", tool_use_id: id, name: "read_files", content }],
	})
	const prompt = (promptOrdinal: number, text?: string) => ({ text, isAnswer: false, promptOrdinal, answerOccurrence: 0 })

	it("cuts before the edited prompt when an answered question precedes it", () => {
		// The chat shows: task, answer "B", follow-up. The answer is a tool
		// result, so the follow-up is the second prompt, not the third.
		const messages = [
			user("task"),
			askQuestion("q1"),
			answer("q1", "B"),
			assistant("done with B"),
			user("follow-up"),
			assistant("follow-up done"),
			user("third prompt"),
		]

		const plan = planEditRestart(messages, prompt(2, "follow-up"))

		expect(plan?.initialMessages).toHaveLength(4)
		expect(plan?.checkpointRunCount).toBe(2)
		expect(plan?.carriedRuns).toBe(1)
	})

	it("trusts the row's text over the ordinal when they disagree", () => {
		// A prompt that was queued but never reached the agent has a chat row
		// and no persisted message, so the ordinal points one prompt too far.
		const messages = [user("task"), assistant("done"), user("second"), assistant("done")]

		expect(planEditRestart(messages, prompt(3, "second"))?.initialMessages).toHaveLength(2)
	})

	it("keeps the ordinal when the text cannot be found", () => {
		const messages = [user("task"), assistant("done"), user("@/src/a.ts resolved into something else")]

		expect(planEditRestart(messages, prompt(2, "look at @/src/b.ts"))?.initialMessages).toHaveLength(2)
	})

	it("numbers checkpoint runs like core: tool results and reminders start no run", () => {
		const messages = [
			user("task"),
			toolCall("t1"),
			toolResult("t1"),
			toolCall("t2"),
			toolResult("t2"),
			assistant("done"),
			{ role: "user", content: "[SYSTEM] reminder", metadata: { kind: "completion_reminder" } },
			assistant("really done"),
			user("second"),
			toolCall("t3"),
			toolResult("t3"),
			user("third"),
		]

		expect(planEditRestart(messages, prompt(2, "second"))?.checkpointRunCount).toBe(2)
		expect(planEditRestart(messages, prompt(3, "third"))?.checkpointRunCount).toBe(3)
	})

	it("does not count the hidden act-mode continuation as a run", () => {
		const messages = [
			{ role: "user", content: wrapped("plan the change", "plan") },
			assistant("a plan"),
			{ role: "user", content: wrapped(ACT_MODE_CONTINUATION_PROMPT) },
			assistant("implemented"),
			{ role: "user", content: wrapped("adjust the tests") },
		]

		const plan = planEditRestart(messages, prompt(2, "adjust the tests"))

		expect(plan?.initialMessages).toHaveLength(4)
		expect(plan?.checkpointRunCount).toBe(2)
	})

	it("restarts an edited answer after the question, with the answer taken out", () => {
		const messages = [user("task"), askQuestion("q1"), answer("q1", "B"), assistant("done with B"), user("follow-up")]

		const plan = planEditRestart(messages, { text: "B", isAnswer: true, promptOrdinal: 1, answerOccurrence: 1 })

		expect(plan?.initialMessages).toHaveLength(3)
		expect(plan?.initialMessages[2]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "q1",
					name: "ask_question",
					content: "The user will answer in their next message.",
				},
			],
		})
		expect(plan?.checkpointRunCount).toBeUndefined()
		expect(plan?.carriedRuns).toBe(1)
		// The source history is untouched.
		expect(messages[2]).toEqual(answer("q1", "B"))
	})

	it("picks the right answer among several with the same text", () => {
		const messages = [
			user("task"),
			askQuestion("q1"),
			answer("q1", "yes"),
			askQuestion("q2"),
			answer("q2", "yes"),
			assistant("done"),
		]

		const plan = planEditRestart(messages, { text: "yes", isAnswer: true, promptOrdinal: 1, answerOccurrence: 2 })

		expect(plan?.initialMessages).toHaveLength(5)
		expect(plan?.initialMessages[2]).toEqual(answer("q1", "yes"))
	})

	it("restarts edited rejection feedback after the rejected call, with the feedback taken out", () => {
		const denial =
			"The user denied this operation. The user provided the following feedback:\n<feedback>\nuse the other file\n</feedback>"
		const messages = [user("task"), toolCall("e1", "editor"), toolResult("e1", denial), assistant("ok")]

		const plan = planEditRestart(messages, {
			text: "use the other file",
			isAnswer: true,
			promptOrdinal: 1,
			answerOccurrence: 1,
		})

		expect(plan?.initialMessages).toHaveLength(3)
		const block = (plan?.initialMessages[2].content as Array<{ content: string }>)[0]
		expect(block.content).toBe("The user denied this operation. The user's feedback follows in their next message.")
	})

	it("returns undefined when the answer is not in the history", () => {
		const messages = [user("task"), assistant("done")]

		expect(planEditRestart(messages, { text: "B", isAnswer: true, promptOrdinal: 1, answerOccurrence: 1 })).toBeUndefined()
	})
})

describe("extractSdkUserText", () => {
	it("extracts text from string and block content", () => {
		expect(extractSdkUserText({ role: "user", content: "  hello  " })).toBe("hello")
		expect(
			extractSdkUserText({
				role: "user",
				content: [
					{ type: "text", text: "first" },
					{ type: "file", content: "second" },
					{ type: "image", source: "ignored" },
				],
			}),
		).toBe("first\nsecond")
		expect(extractSdkUserText({ role: "user", content: 42 })).toBe("")
	})
})
