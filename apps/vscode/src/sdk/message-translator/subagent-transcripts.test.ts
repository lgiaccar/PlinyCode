import type { CoreSessionEvent } from "@plinycode/core"
import type { AgentEvent } from "@plinycode/shared"
import type { ClineMessage, ClineSaySubagentStatus } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { MessageTranslatorState, translateSessionEvent } from "./index"
import { SubagentTranscripts, type SubagentTranscriptUpdate } from "./subagent-transcripts"

const ROOT = "agent-root"

function agentEvent(event: Record<string, unknown>): CoreSessionEvent {
	return { type: "agent_event", payload: { sessionId: "session-1", event } } as unknown as CoreSessionEvent
}

/** A sub-agent's event as the engine forwards it: tagged with its id and its parent's. */
function subEvent(agentId: string, event: Record<string, unknown>, parentAgentId = ROOT): CoreSessionEvent {
	return agentEvent({ ...event, agentId, parentAgentId })
}

function spawn(state: MessageTranslatorState, callId: string, task: string, subAgentId: string, agentId?: string) {
	const tag = agentId ? { agentId, parentAgentId: ROOT } : {}
	translateSessionEvent(
		agentEvent({
			type: "content_start",
			contentType: "tool",
			toolName: "spawn_agent",
			toolCallId: callId,
			input: { task },
			...tag,
		}),
		state,
	)
	// The engine names the run as soon as it binds it.
	return translateSessionEvent(
		agentEvent({
			type: "content_update",
			contentType: "tool",
			toolName: "spawn_agent",
			toolCallId: callId,
			update: { subAgentId, toolCalls: 0 },
			...tag,
		}),
		state,
	)
}

const says = (messages: ClineMessage[]) => messages.map((message) => message.say ?? message.ask)

describe("sub-agent transcripts", () => {
	it("files a sub-agent's events in its transcript and keeps them out of the main chat", () => {
		const state = new MessageTranslatorState()
		spawn(state, "c1", "Explore the repo", "sub-1")
		const transcripts = state.getSubagentTranscripts()

		const results = [
			subEvent("sub-1", { type: "iteration_start", iteration: 1 }),
			subEvent("sub-1", { type: "content_start", contentType: "text", text: "Look", accumulated: "Looking" }),
			subEvent("sub-1", { type: "content_end", contentType: "text", text: "Looking around." }),
			subEvent("sub-1", {
				type: "content_start",
				contentType: "tool",
				toolName: "run_commands",
				toolCallId: "s1",
				input: { commands: ["git status"] },
			}),
			subEvent("sub-1", {
				type: "content_end",
				contentType: "tool",
				toolName: "run_commands",
				toolCallId: "s1",
				output: "clean",
			}),
			subEvent("sub-1", { type: "usage", inputTokens: 10, outputTokens: 2 }),
			subEvent("sub-1", { type: "done", reason: "completed", iterations: 1 }),
		].map((event) => translateSessionEvent(event, state))

		for (const result of results) {
			expect(result.messages).toEqual([])
			expect(result.usage).toBeUndefined()
			expect(result.turnComplete).toBe(false)
		}
		const transcript = transcripts.snapshot("sub-1")
		// The text row streamed and then finalized in place; the command row likewise.
		expect(says(transcript)).toEqual(["api_req_started", "text", "command", "api_req_started"])
		expect(transcript[1]).toMatchObject({ text: "Looking around.", partial: false })
		expect(transcript[2]).toMatchObject({ partial: false, commandCompleted: true })
		expect(transcript[2].text).toContain("git status")
		// The root's streaming state is untouched: its spawn row is still running.
		expect(state.getSpawnAgentItems()).toHaveLength(1)
		expect(state.getSpawnAgentItems()[0]).toMatchObject({ agentId: "sub-1", status: "running" })
	})

	it("still shows the root's own events while a sub-agent runs", () => {
		const state = new MessageTranslatorState()
		spawn(state, "c1", "Explore", "sub-1")
		// A read the root runs alongside its spawn_agent call (both are parallel tools).
		const start = translateSessionEvent(
			agentEvent({
				type: "content_start",
				contentType: "tool",
				toolName: "read_files",
				toolCallId: "r1",
				input: { files: [{ path: "a.ts" }] },
			}),
			state,
		)
		expect(says(start.messages)).toEqual(["tool"])
	})

	it("keeps two concurrent sub-agents apart", () => {
		const state = new MessageTranslatorState()
		spawn(state, "c1", "First", "sub-1")
		spawn(state, "c2", "Second", "sub-2")
		// Interleaved streams: each keeps its own streaming text row.
		translateSessionEvent(subEvent("sub-1", { type: "content_start", contentType: "text", accumulated: "one" }), state)
		translateSessionEvent(subEvent("sub-2", { type: "content_start", contentType: "text", accumulated: "two" }), state)
		translateSessionEvent(subEvent("sub-1", { type: "content_end", contentType: "text", text: "one done" }), state)
		translateSessionEvent(subEvent("sub-2", { type: "content_end", contentType: "text", text: "two done" }), state)

		const transcripts = state.getSubagentTranscripts()
		expect(transcripts.snapshot("sub-1").map((m) => m.text)).toEqual(["one done"])
		expect(transcripts.snapshot("sub-2").map((m) => m.text)).toEqual(["two done"])
		expect(transcripts.snapshot("sub-1")[0].ts).not.toBe(transcripts.snapshot("sub-2")[0].ts)
	})

	it("leaves asks out: approvals and errors are answered in the main chat", () => {
		const state = new MessageTranslatorState()
		spawn(state, "c1", "Explore", "sub-1")
		const result = translateSessionEvent(
			subEvent("sub-1", { type: "error", error: new Error("provider down"), recoverable: false, iteration: 1 }),
			state,
		)
		expect(result.messages).toEqual([])
		expect(result.turnComplete).toBe(false)
		expect(state.wasErrorSeen()).toBe(false)
		// The failed request still shows in the transcript.
		expect(says(state.getSubagentTranscripts().snapshot("sub-1"))).toEqual(["api_req_started"])
	})

	it("files an event that lost its parentAgentId under the sub-agent it names", () => {
		const state = new MessageTranslatorState()
		spawn(state, "c1", "Explore", "sub-1")
		const result = translateSessionEvent(
			agentEvent({ type: "content_end", contentType: "text", text: "untagged", agentId: "sub-1" }),
			state,
		)
		expect(result.messages).toEqual([])
		expect(
			state
				.getSubagentTranscripts()
				.snapshot("sub-1")
				.map((m) => m.text),
		).toEqual(["untagged"])

		// An untagged event naming no known sub-agent is the root's.
		const root = translateSessionEvent(agentEvent({ type: "content_end", contentType: "text", text: "root text" }), state)
		expect(root.messages.map((m) => m.text)).toEqual(["root text"])
	})

	it("nests a second-level sub-agent under its parent's transcript", () => {
		const state = new MessageTranslatorState()
		spawn(state, "c1", "Review the module", "sub-1")
		// The first-level sub-agent delegates in turn: its spawn_agent call is one of its own events.
		spawn(state, "n1", "Check the tests", "sub-1-1", "sub-1")
		translateSessionEvent(
			subEvent("sub-1-1", { type: "content_end", contentType: "text", text: "tests are fine" }, "sub-1"),
			state,
		)

		const transcripts = state.getSubagentTranscripts()
		// The parent's transcript has the nested status row, whose item points at the child by id...
		const statusRow = transcripts.snapshot("sub-1").find((m) => m.say === "subagent")
		expect(statusRow).toBeDefined()
		const status = JSON.parse(statusRow?.text ?? "{}") as ClineSaySubagentStatus
		expect(status.items.map((item) => [item.prompt, item.agentId])).toEqual([["Check the tests", "sub-1-1"]])
		// ...and the child's own transcript is filed under that id.
		expect(transcripts.snapshot("sub-1-1").map((m) => m.text)).toEqual(["tests are fine"])
		// The root's row lists only its own sub-agent.
		expect(state.getSpawnAgentItems().map((item) => item.agentId)).toEqual(["sub-1"])
	})

	it("shows a sub-agent's final answer as text, not as the task's completion", () => {
		const state = new MessageTranslatorState()
		spawn(state, "c1", "Explore", "sub-1")
		translateSessionEvent(subEvent("sub-1", { type: "content_end", contentType: "text", text: "My report" }), state)
		translateSessionEvent(subEvent("sub-1", { type: "done", reason: "completed", iterations: 1 }), state)

		const transcript = state.getSubagentTranscripts().snapshot("sub-1")
		expect(transcript.map((m) => [m.say, m.text])).toEqual([["text", "My report"]])
		expect(state.wasAttemptCompletionSeen()).toBe(false)
	})

	it("survives the root's next iteration and goes when cleared", () => {
		const state = new MessageTranslatorState()
		spawn(state, "c1", "Explore", "sub-1")
		translateSessionEvent(subEvent("sub-1", { type: "content_end", contentType: "text", text: "kept" }), state)
		translateSessionEvent(agentEvent({ type: "iteration_start", iteration: 2 }), state)
		expect(state.getSubagentTranscripts().snapshot("sub-1")).toHaveLength(1)

		state.clearSubagentTranscripts()
		expect(state.getSubagentTranscripts().snapshot("sub-1")).toEqual([])
	})
})

describe("SubagentTranscripts", () => {
	const textEvent = (agentId: string, text: string) =>
		({ type: "content_end", contentType: "text", text, agentId, parentAgentId: ROOT }) as unknown as AgentEvent

	/** Translation stand-in: one finished text row per event, with a fresh ts. */
	function textRows(): (event: AgentEvent, state: MessageTranslatorState) => ClineMessage[] {
		return (event, state) => [
			{ ts: state.nextTs(), type: "say", say: "text", text: (event as { text?: string }).text ?? "", partial: false },
		]
	}

	it("keeps at most the last N messages of a sub-agent", () => {
		const transcripts = new SubagentTranscripts(() => new MessageTranslatorState(), { maxMessages: 3, maxAgents: 5 })
		for (const text of ["a", "b", "c", "d", "e"]) {
			transcripts.record(textEvent("sub-1", text), textRows())
		}
		expect(transcripts.snapshot("sub-1").map((m) => m.text)).toEqual(["c", "d", "e"])
	})

	it("drops a late update to a message that already fell out of the buffer", () => {
		const transcripts = new SubagentTranscripts(() => new MessageTranslatorState(), { maxMessages: 2, maxAgents: 5 })
		let firstTs = 0
		transcripts.record(textEvent("sub-1", "first"), (_event, state) => {
			firstTs = state.nextTs()
			return [{ ts: firstTs, type: "say", say: "text", text: "first", partial: true }]
		})
		transcripts.record(textEvent("sub-1", "b"), textRows())
		transcripts.record(textEvent("sub-1", "c"), textRows())
		transcripts.record(textEvent("sub-1", "first, finished"), () => [
			{ ts: firstTs, type: "say", say: "text", text: "first, finished", partial: false },
		])
		expect(transcripts.snapshot("sub-1").map((m) => m.text)).toEqual(["b", "c"])
	})

	it("keeps at most N sub-agents, dropping the oldest and telling its viewers", () => {
		const transcripts = new SubagentTranscripts(() => new MessageTranslatorState(), { maxMessages: 10, maxAgents: 2 })
		const updates: SubagentTranscriptUpdate[] = []
		transcripts.subscribe("sub-1", (update) => updates.push(update))
		for (const agentId of ["sub-1", "sub-2", "sub-3"]) {
			transcripts.record(textEvent(agentId, agentId), textRows())
		}
		expect(transcripts.has("sub-1")).toBe(false)
		expect(transcripts.has("sub-2")).toBe(true)
		expect(transcripts.has("sub-3")).toBe(true)
		expect(updates.map((update) => [update.reset, update.messages.length])).toEqual([
			[false, 1],
			[true, 0],
		])
	})

	it("pushes each change to the sub-agent's subscribers until they unsubscribe", () => {
		const transcripts = new SubagentTranscripts(() => new MessageTranslatorState())
		const one: SubagentTranscriptUpdate[] = []
		const two: SubagentTranscriptUpdate[] = []
		const unsubscribe = transcripts.subscribe("sub-1", (update) => one.push(update))
		transcripts.subscribe("sub-2", (update) => two.push(update))

		transcripts.record(textEvent("sub-1", "hello"), textRows())
		unsubscribe()
		transcripts.record(textEvent("sub-1", "again"), textRows())

		expect(one.map((update) => update.messages.map((m) => m.text))).toEqual([["hello"]])
		expect(two).toEqual([])
	})

	it("ignores an event that names no agent", () => {
		const transcripts = new SubagentTranscripts(() => new MessageTranslatorState())
		transcripts.record({ type: "done", reason: "completed", iterations: 1 } as unknown as AgentEvent, textRows())
		expect(transcripts.has("")).toBe(false)
	})
})
