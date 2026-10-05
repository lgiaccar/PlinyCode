import type { CoreSessionEvent } from "@plinycode/core"
import type { Message as SdkMessage } from "@plinycode/llms"
import type { AgentEvent } from "@plinycode/shared"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { getApiMetrics, getConversationApiMetrics } from "@shared/getApiMetrics"
import { describe, expect, it } from "vitest"
import { DEFAULT_ADVISOR_SETTINGS } from "../advisor/advisor-settings"
import type { AdvisorToolOutput } from "../advisor/advisor-tool"
import { MessageTranslatorState, sdkMessagesToClineMessages, translateSessionEvent } from "./index"

const SONNET_5 = DEFAULT_ADVISOR_SETTINGS.model

const INPUT = { question: "Mutex or channel?\nThe cache is shared by 8 workers.", context: "x".repeat(1200) }
const OUTPUT: AdvisorToolOutput = {
	advice: "Use a mutex.\n\n1. Guard `entries`.\n2. Rerun `go test -race`.",
	model: SONNET_5,
	usage: { inputTokens: 812, outputTokens: 640, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.012 },
}

function agentEvent(event: Record<string, unknown>): CoreSessionEvent {
	return { type: "agent_event", payload: { sessionId: "task-1", event: event as unknown as AgentEvent } } as CoreSessionEvent
}

/** Run one advisor call through the live translator; `end` is merged into the content_end event. */
function liveCall(end: Record<string, unknown>, state = new MessageTranslatorState()) {
	const started = translateSessionEvent(
		agentEvent({ type: "content_start", contentType: "tool", toolName: "ask_advisor", toolCallId: "call-1", input: INPUT }),
		state,
	).messages
	const ended = translateSessionEvent(
		agentEvent({ type: "content_end", contentType: "tool", toolName: "ask_advisor", toolCallId: "call-1", ...end }),
		state,
	).messages
	return { started, ended }
}

const usageRows = (messages: ClineMessage[]) =>
	messages.filter((message) => message.say === "subagent_usage").map((message) => JSON.parse(message.text ?? "{}"))

describe("advisor chat rows", () => {
	it("shows the question as soon as the call starts", () => {
		const { started } = liveCall({ output: OUTPUT })
		expect(started).toHaveLength(1)
		expect(started[0]).toMatchObject({ type: "say", say: "info", partial: true })
		expect(started[0].text).toBe(
			"**Asked the advisor**\n\n> Mutex or channel?\n> The cache is shared by 8 workers.\n\n_Sent with 1,200 characters of context._",
		)
	})

	it("adds the advice, with the model and the cost, and a usage row for the conversation's cost", () => {
		const { started, ended } = liveCall({ output: OUTPUT })
		const [question, advice, usage] = ended
		expect(ended).toHaveLength(3)
		// The question row is the same row, no longer partial.
		expect(question).toMatchObject({ ts: started[0].ts, say: "info", partial: false, text: started[0].text })
		expect(advice.say).toBe("info")
		expect(advice.text).toBe(
			"**The advisor's answer** (`global.anthropic.claude-sonnet-5` · 812 in / 640 out tokens · $0.0120)\n\n" +
				"Use a mutex.\n\n1. Guard `entries`.\n2. Rerun `go test -race`.",
		)
		expect(usage.say).toBe("subagent_usage")
		expect(JSON.parse(usage.text ?? "{}")).toEqual({
			source: "advisor",
			tokensIn: 812,
			tokensOut: 640,
			cacheWrites: 0,
			cacheReads: 0,
			cost: 0.012,
		})
		// The task header, the budget check and the history record all sum these rows.
		expect(getApiMetrics(ended)).toMatchObject({ totalCost: 0.012, totalTokensIn: 812, totalTokensOut: 640 })
	})

	it("shows why a refused call got no advice, and records no cost", () => {
		const error = JSON.stringify({
			error: "The advisor has been asked 5 times in this conversation, which is the limit (5). Decide on your own.",
		})
		const { ended } = liveCall({ output: { error: "…" }, error })
		expect(ended.map((message) => message.say)).toEqual(["info", "info"])
		expect(ended[1].text).toBe(
			"**The advisor was not consulted**\n\nThe advisor has been asked 5 times in this conversation, which is the limit (5). Decide on your own.",
		)
		expect(getApiMetrics(ended).totalCost).toBe(0)
	})

	it("records the estimated cost of a call that failed after it was billed", () => {
		const output: AdvisorToolOutput = {
			error: "The advisor could not answer: timed out after 60 s. Decide on your own.",
			model: SONNET_5,
			usage: {
				inputTokens: 900,
				outputTokens: 30,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalCost: 0.0032,
				estimated: true,
			},
		}
		const { ended } = liveCall({ output })
		expect(ended[1].text).toBe(
			"**The advisor could not answer** (`global.anthropic.claude-sonnet-5` · ~900 in / ~30 out tokens · ~$0.0032)\n\n" +
				"The advisor could not answer: timed out after 60 s. Decide on your own.",
		)
		expect(usageRows(ended)).toEqual([expect.objectContaining({ source: "advisor", cost: 0.0032, estimated: true })])
		expect(getApiMetrics(ended)).toMatchObject({ totalCost: 0.0032, hasEstimatedUsage: true })
	})

	it("rebuilds the same rows and the same cost when the conversation is reopened from history", () => {
		const messages: SdkMessage[] = [
			{ role: "user", content: '<user_input mode="act">fix the flaky cache test</user_input>' } as SdkMessage,
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Two fixes failed; asking for advice." },
					{ type: "tool_use", id: "call-1", name: "ask_advisor", input: INPUT },
				],
				metrics: { inputTokens: 5000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.02 },
			} as SdkMessage,
			// Core persists an object result as its JSON.
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "call-1", content: JSON.stringify(OUTPUT) }],
			} as SdkMessage,
			{ role: "assistant", content: [{ type: "text", text: "Done: guarded the map with a mutex." }] } as SdkMessage,
		]
		const replayed = sdkMessagesToClineMessages(messages)

		const info = replayed.filter((message) => message.say === "info").map((message) => message.text ?? "")
		expect(info).toHaveLength(2)
		expect(info[0]).toContain("**Asked the advisor**\n\n> Mutex or channel?")
		expect(info[1]).toContain("**The advisor's answer** (`global.anthropic.claude-sonnet-5`")
		expect(info[1]).toContain("Use a mutex.")
		expect(usageRows(replayed)).toEqual([expect.objectContaining({ source: "advisor", cost: 0.012 })])
		// The model call's own cost plus the advisor's.
		expect(getConversationApiMetrics(replayed).totalCost).toBeCloseTo(0.032, 6)
		// Never rendered through the generic tool row, which shows nothing for an unknown tool.
		expect(replayed.some((message) => message.say === "tool")).toBe(false)
	})

	it("rebuilds a refused call from history without a cost", () => {
		const messages: SdkMessage[] = [
			{ role: "user", content: '<user_input mode="act">fix it</user_input>' } as SdkMessage,
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call-1", name: "ask_advisor", input: { question: "Which one?" } }],
			} as SdkMessage,
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call-1",
						content: JSON.stringify({
							error: "The advisor is turned off (plinycode.advisor.use). Decide on your own.",
						}),
						is_error: true,
					},
				],
			} as SdkMessage,
		]
		const replayed = sdkMessagesToClineMessages(messages)
		const info = replayed.filter((message) => message.say === "info").map((message) => message.text ?? "")
		expect(info[1]).toBe(
			"**The advisor was not consulted**\n\nThe advisor is turned off (plinycode.advisor.use). Decide on your own.",
		)
		expect(usageRows(replayed)).toEqual([])
	})
})
