import type { AgentMessage } from "@plinycode/shared"
import { describe, expect, it, vi } from "vitest"
import {
	createRouterCompletionGuard,
	ESCALATED_REMINDER,
	evaluateReply,
	type GuardRule,
	UNFINISHED_TURN_REMINDER,
	WAIT_BAIL_OUT_REMINDER,
} from "./completion-guard"

function reply(text: string): AgentMessage {
	return { id: "a", role: "assistant", content: [{ type: "text", text }], createdAt: 0 }
}

function user(text: string): AgentMessage {
	return {
		id: "u",
		role: "user",
		content: [{ type: "text", text: `<user_input mode="act">${text}</user_input>` }],
		createdAt: 0,
	}
}

function shell(entries: Array<{ query: string; result: string; error?: string; success: boolean }>): AgentMessage {
	return {
		id: "t",
		role: "tool",
		content: [{ type: "tool-result", toolCallId: "c1", toolName: "run_commands", output: entries }],
		createdAt: 0,
	}
}

const unfinished = reply("Let me check the log:")
const done = reply("All tests pass.")

describe("evaluateReply", () => {
	const context = (message: AgentMessage, runMessages?: AgentMessage[], userRequest = "", fired: GuardRule[] = []) => ({
		message,
		runMessages,
		userRequest,
		firedRules: new Set(fired),
	})

	it("names the rule that fired, most reliable first", () => {
		expect(evaluateReply("Let me check the log:", context(unfinished))?.rule).toBe("announcement")
		expect(evaluateReply("I'll check again at 15:28. Stand by!", context(reply("x")))?.rule).toBe("wait-bail-out")
		expect(evaluateReply(`ok${" .  ".repeat(3000)}`, context(reply("x")))?.rule).toBe("degenerate")
		expect(evaluateReply("All tests pass.", context(done))).toBeUndefined()
	})

	it("fires the failed-command rule once, unless the reply hands the failure back as a question", () => {
		const failed = shell([
			{ query: "make", result: "[Command exited with code 2]", error: "Command exited with code 2", success: false },
		])
		const report = reply("The build fails because libfoo is missing from the link line.")
		const hit = evaluateReply(
			"The build fails because libfoo is missing from the link line.",
			context(report, [failed, report]),
		)
		expect(hit?.rule).toBe("after-failed-command")
		expect(hit?.reminder).toContain("exit code 2")
		expect(
			evaluateReply(
				"The build fails because libfoo is missing.",
				context(report, [failed, report], "", ["after-failed-command"]),
			)?.rule,
		).toBeUndefined()

		const asking = reply("The build fails because libfoo is missing. Should I install it via conan?")
		expect(
			evaluateReply(
				"The build fails because libfoo is missing. Should I install it via conan?",
				context(asking, [failed, asking]),
			),
		).toBeUndefined()
	})

	it("fires the detached-command rule only when someone is waiting for the result", () => {
		const detached = shell([
			{
				query: "run.ps1",
				result: "The command was still starting or running after 300 seconds, so Cline automatically proceeded while leaving it running in the terminal.\nThis is partial output; further output is being redirected to this file, which you can read to check progress: C:\\log.txt",
				success: true,
			},
		])
		const started = reply("The benchmark is running in the background; the log is at C:\\log.txt.")
		const text = "The benchmark is running in the background; the log is at C:\\log.txt."
		expect(evaluateReply(text, context(started, [detached, started], "start the dev server"))).toBeUndefined()
		expect(
			evaluateReply(text, context(started, [detached, started], "run the benchmark and report back when it finishes"))
				?.rule,
		).toBe("after-detached-command")
		const later = reply("The benchmark is running. I'll check back in 10 minutes.")
		expect(
			evaluateReply(
				"The benchmark is running. I'll check back in 10 minutes.",
				context(later, [detached, later], "start it"),
			)?.rule,
		).toBe("after-detached-command")
	})

	it("fires the readiness rule when the user asked to run it", () => {
		const ready = "The script is ready to run and handles every branch."
		expect(evaluateReply(ready, context(reply(ready), undefined, "write and run the benchmark"))?.rule).toBe("readiness")
		expect(evaluateReply(ready, context(reply(ready), undefined, "write the benchmark script"))).toBeUndefined()
	})
})

describe("createRouterCompletionGuard", () => {
	it("nudges an unfinished reply with the matching reminder and reports it", async () => {
		const nudges: unknown[] = []
		const guard = createRouterCompletionGuard({ isActive: () => true, onNudge: (info) => nudges.push(info) })
		expect(await guard({ message: unfinished, iteration: 4 })).toBe(UNFINISHED_TURN_REMINDER)
		expect(nudges).toEqual([{ rule: "announcement", excerpt: "Let me check the log:", nudgesThisRun: 1, escalated: false }])
		expect(await guard({ message: reply("I'll check again at 15:28. Stand by!"), iteration: 9 })).toBe(WAIT_BAIL_OUT_REMINDER)
		expect(await guard({ message: done, iteration: 12 })).toBeUndefined()
	})

	it("escalates on the second consecutive stall and accepts the third", async () => {
		const onEscalate = vi.fn()
		const nudges: Array<{ escalated: boolean }> = []
		const guard = createRouterCompletionGuard({ isActive: () => true, onEscalate, onNudge: (info) => nudges.push(info) })
		expect(await guard({ message: unfinished, iteration: 2 })).toBe(UNFINISHED_TURN_REMINDER)
		expect(await guard({ message: unfinished, iteration: 3 })).toBe(ESCALATED_REMINDER)
		expect(onEscalate).toHaveBeenCalledTimes(1)
		expect(nudges.map((n) => n.escalated)).toEqual([false, true])
		expect(await guard({ message: unfinished, iteration: 4 })).toBeUndefined()
		// A stall later in the same run, after real progress, is a fresh first nudge.
		expect(await guard({ message: unfinished, iteration: 7 })).toBe(UNFINISHED_TURN_REMINDER)
		expect(onEscalate).toHaveBeenCalledTimes(1)
	})

	it("caps reminders per run and resets on the next run", async () => {
		const guard = createRouterCompletionGuard({ isActive: () => true, maxNudgesPerRun: 2 })
		expect(await guard({ message: unfinished, iteration: 2 })).toBeDefined()
		expect(await guard({ message: unfinished, iteration: 5 })).toBeDefined()
		expect(await guard({ message: unfinished, iteration: 8 })).toBeUndefined()
		// Iterations restart: a new run.
		expect(await guard({ message: unfinished, iteration: 1 })).toBeDefined()
	})

	it("does nothing while inactive", async () => {
		const guard = createRouterCompletionGuard({ isActive: () => false })
		expect(await guard({ message: unfinished, iteration: 1 })).toBeUndefined()
	})

	describe("judge", () => {
		const messages = [user("build and run the benchmark"), done]

		it("consults the judge once per agentic run when no rule fired, and nudges on not-done", async () => {
			const judge = vi.fn(async () => ({ done: false, reason: "The script was written but never run" }))
			const outcomes: unknown[] = []
			const guard = createRouterCompletionGuard({
				isActive: () => true,
				toolCallsThisRun: () => 3,
				judge,
				onJudge: (outcome, reason) => outcomes.push([outcome, reason]),
			})
			const reminder = await guard({ message: done, iteration: 5, runMessages: messages, messages })
			expect(reminder).toContain("The script was written but never run.")
			expect(judge).toHaveBeenCalledWith(expect.objectContaining({ userRequest: "build and run the benchmark" }))
			expect(outcomes).toEqual([["not-done", "The script was written but never run"]])
			// The reply that answers the judge's reminder is taken at its word, and the judge is spent.
			expect(await guard({ message: done, iteration: 6, runMessages: messages, messages })).toBeUndefined()
			expect(await guard({ message: done, iteration: 9, runMessages: messages, messages })).toBeUndefined()
			expect(judge).toHaveBeenCalledTimes(1)
		})

		it("accepts a done verdict and a missing verdict alike", async () => {
			const guardDone = createRouterCompletionGuard({
				isActive: () => true,
				toolCallsThisRun: () => 1,
				judge: async () => ({ done: true }),
			})
			expect(await guardDone({ message: done, iteration: 2, messages })).toBeUndefined()
			const outcomes: string[] = []
			const guardSilent = createRouterCompletionGuard({
				isActive: () => true,
				toolCallsThisRun: () => 1,
				judge: async () => undefined,
				onJudge: (outcome) => outcomes.push(outcome),
			})
			expect(await guardSilent({ message: done, iteration: 2, messages })).toBeUndefined()
			expect(outcomes).toEqual(["no-verdict"])
		})

		it("skips the judge for chat replies, plan mode and replies right after a nudge", async () => {
			const judge = vi.fn(async () => ({ done: false }))
			const chat = createRouterCompletionGuard({ isActive: () => true, toolCallsThisRun: () => 0, judge })
			expect(await chat({ message: done, iteration: 1, messages })).toBeUndefined()
			const plan = createRouterCompletionGuard({
				isActive: () => true,
				toolCallsThisRun: () => 2,
				getMode: () => "plan",
				judge,
			})
			expect(await plan({ message: done, iteration: 1, messages })).toBeUndefined()
			const nudged = createRouterCompletionGuard({ isActive: () => true, toolCallsThisRun: () => 2, judge })
			expect(await nudged({ message: unfinished, iteration: 1, messages })).toBe(UNFINISHED_TURN_REMINDER)
			expect(await nudged({ message: done, iteration: 2, messages })).toBeUndefined()
			expect(judge).not.toHaveBeenCalled()
		})
	})
})
