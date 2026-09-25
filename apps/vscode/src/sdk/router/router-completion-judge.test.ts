import type { AgentMessage, AgentModel, AgentModelEvent } from "@plinycode/shared"
import { describe, expect, it } from "vitest"
import type { JudgeContext } from "./completion-guard"
import { buildJudgeRequest, parseJudgeVerdict, runCompletionJudge, toolDigest } from "./router-completion-judge"

function assistant(text: string): AgentMessage {
	return { id: "a", role: "assistant", content: [{ type: "text", text }], createdAt: 0 }
}

function tool(toolName: string, output: unknown, isError?: boolean): AgentMessage {
	return {
		id: "t",
		role: "tool",
		content: [{ type: "tool-result", toolCallId: "c", toolName, output, ...(isError ? { isError } : {}) }],
		createdAt: 0,
	}
}

function replying(text: string): AgentModel {
	return {
		async *stream() {
			yield { type: "text-delta", text } satisfies AgentModelEvent
			yield { type: "finish", reason: "stop" } satisfies AgentModelEvent
		},
	}
}

const reply = assistant("The benchmark script is ready to run. Would you like me to run it now?")
const context: JudgeContext = {
	userRequest: "build in CUDA mode and run the GR9hA performance case",
	message: reply,
	runMessages: [
		tool("read_files", "…"),
		tool("editor", "Edited run.ps1"),
		tool("run_commands", [
			{ query: "make", result: "[Command exited with code 1]", error: "Command exited with code 1", success: false },
		]),
		reply,
	],
	messages: [],
}

describe("toolDigest", () => {
	it("lists each tool call with its outcome", () => {
		expect(toolDigest(context.runMessages)).toEqual(["read_files: ok", "editor: ok", "run_commands: failed"])
		expect(toolDigest([tool("x", "boom", true)])).toEqual(["x: failed"])
	})
})

describe("buildJudgeRequest", () => {
	it("sends the request, the tool digest, the last result and the reply, with reasoning off", () => {
		const built = buildJudgeRequest(context, new AbortController().signal)
		const prompt = (built.messages[0].content[0] as { text: string }).text
		expect(prompt).toContain("User's request:\nbuild in CUDA mode and run the GR9hA performance case")
		expect(prompt).toContain("run_commands: failed")
		expect(prompt).toContain("Last tool result (excerpt):")
		expect(prompt).toContain("Would you like me to run it now?")
		expect(built.tools).toEqual([])
		expect(built.options).toMatchObject({ thinking: false })
		expect(built.systemPrompt).toContain('"done": true | false')
	})

	it("keeps both ends of a very long reply", () => {
		const long = assistant(`START ${"x".repeat(5000)} END`)
		const built = buildJudgeRequest({ ...context, message: long }, new AbortController().signal)
		const prompt = (built.messages[0].content[0] as { text: string }).text
		expect(prompt).toContain("START")
		expect(prompt).toContain("[…]")
		expect(prompt).toContain("END")
		expect(prompt.length).toBeLessThan(4500)
	})
})

describe("parseJudgeVerdict", () => {
	it("reads plain, fenced and quoted verdicts", () => {
		expect(parseJudgeVerdict('{"done": false, "reason": "It asked permission to run."}')).toEqual({
			done: false,
			reason: "It asked permission to run.",
		})
		expect(parseJudgeVerdict('```json\n{"done": "true"}\n```')).toEqual({ done: true })
		expect(parseJudgeVerdict('<think>hmm {"done": false}</think>{"done": true, "reason": "finished"}')).toEqual({
			done: true,
			reason: "finished",
		})
	})

	it("rejects anything without a done flag", () => {
		expect(parseJudgeVerdict("The task is done.")).toBeUndefined()
		expect(parseJudgeVerdict('{"reason": "no flag"}')).toBeUndefined()
	})
})

describe("runCompletionJudge", () => {
	it("returns the verdict", async () => {
		const result = await runCompletionJudge({
			model: replying('{"done": false, "reason": "never ran"}'),
			context,
			timeoutMs: 1000,
		})
		expect(result).toEqual({ verdict: { done: false, reason: "never ran" } })
	})

	it("reports an unusable reply with its raw text", async () => {
		const result = await runCompletionJudge({ model: replying("Looks fine to me."), context, timeoutMs: 1000 })
		expect(result.verdict).toBeUndefined()
		expect(result.error).toContain("unusable reply")
		expect(result.raw).toBe("Looks fine to me.")
	})

	it("gives up after the timeout", async () => {
		const hanging: AgentModel = {
			async *stream(request) {
				await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }))
			},
		}
		const result = await runCompletionJudge({ model: hanging, context, timeoutMs: 20 })
		expect(result.error).toContain("timed out")
	})
})
