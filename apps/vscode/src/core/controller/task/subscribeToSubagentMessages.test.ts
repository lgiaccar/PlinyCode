import type { AgentEvent } from "@plinycode/shared"
import type { SubagentMessagesUpdate } from "@shared/proto/cline/task"
import { SubagentMessagesRequest } from "@shared/proto/cline/task"
import { describe, expect, it, vi } from "vitest"
import { MessageTranslatorState } from "@/sdk/message-translator"
import type { Controller } from "../index"

const registry = vi.hoisted(() => ({ cleanups: new Map<string, () => void>() }))

vi.mock("../grpc-handler", () => ({
	getRequestRegistry: () => ({
		registerRequest: (requestId: string, cleanup: () => void) => registry.cleanups.set(requestId, cleanup),
	}),
}))

import { subscribeToSubagentMessages } from "./subscribeToSubagentMessages"

const textEvent = (agentId: string, text: string) =>
	({ type: "content_end", contentType: "text", text, agentId, parentAgentId: "root" }) as unknown as AgentEvent

function setup() {
	const state = new MessageTranslatorState()
	const transcripts = state.getSubagentTranscripts()
	const record = (agentId: string, text: string) =>
		transcripts.record(textEvent(agentId, text), (event, childState) => [
			{ ts: childState.nextTs(), type: "say", say: "text", text: (event as { text?: string }).text, partial: false },
		])
	const controller = { getSubagentTranscripts: () => transcripts } as unknown as Controller
	const sent: SubagentMessagesUpdate[] = []
	const responseStream = vi.fn(async (update: SubagentMessagesUpdate) => {
		sent.push(update)
	})
	return { record, controller, sent, responseStream }
}

const texts = (update: SubagentMessagesUpdate) => update.messages.map((message) => message.text)

describe("subscribeToSubagentMessages", () => {
	it("sends the transcript so far, then each change, until the stream is cancelled", async () => {
		const { record, controller, sent, responseStream } = setup()
		record("sub-1", "first")
		record("sub-2", "someone else")

		await subscribeToSubagentMessages(
			controller,
			SubagentMessagesRequest.create({ agentId: "sub-1" }),
			responseStream,
			"req-1",
		)
		expect(sent).toHaveLength(1)
		expect(sent[0].reset).toBe(true)
		expect(texts(sent[0])).toEqual(["first"])

		record("sub-1", "second")
		record("sub-2", "not for this view")
		expect(sent).toHaveLength(2)
		expect(sent[1].reset).toBe(false)
		expect(texts(sent[1])).toEqual(["second"])

		// The webview collapses the item: the registry runs the cleanup.
		registry.cleanups.get("req-1")?.()
		record("sub-1", "third")
		expect(sent).toHaveLength(2)
	})

	it("answers an unknown sub-agent with an empty transcript and fills it when it starts", async () => {
		const { record, controller, sent, responseStream } = setup()

		await subscribeToSubagentMessages(
			controller,
			SubagentMessagesRequest.create({ agentId: "sub-9" }),
			responseStream,
			"req-2",
		)
		expect(sent.map((update) => [update.reset, texts(update)])).toEqual([[true, []]])

		record("sub-9", "hello")
		expect(texts(sent[1])).toEqual(["hello"])
		registry.cleanups.get("req-2")?.()
	})

	it("stops pushing to a stream that fails", async () => {
		const { record, controller, responseStream } = setup()
		await subscribeToSubagentMessages(controller, SubagentMessagesRequest.create({ agentId: "sub-1" }), responseStream)
		responseStream.mockRejectedValueOnce(new Error("webview gone"))
		record("sub-1", "lost")
		await vi.waitFor(() => expect(responseStream).toHaveBeenCalledTimes(2))
		await Promise.resolve()
		record("sub-1", "not sent")
		expect(responseStream).toHaveBeenCalledTimes(2)
	})
})
