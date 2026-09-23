import type { CoreSessionEvent } from "@plinycode/core"
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest"
import type { ActiveSession } from "./cline-session-factory"
import { SdkBackgroundSessions, type SdkBackgroundSessionsOptions } from "./sdk-background-sessions"
import type { ToolApprovalRequest } from "./sdk-interaction-coordinator"

function makeSession(sessionId: string, pendingPrompts: unknown[] = []): ActiveSession {
	return {
		sessionId,
		isRunning: true,
		unsubscribe: () => {},
		sdkHost: { pendingPrompts: vi.fn(async () => pendingPrompts) },
	} as unknown as ActiveSession
}

function agentEvent(sessionId: string, event: Record<string, unknown>): CoreSessionEvent {
	return { type: "agent_event", payload: { sessionId, event } } as unknown as CoreSessionEvent
}

function approvalRequest(sessionId: string): ToolApprovalRequest {
	return {
		sessionId,
		agentId: "agent",
		conversationId: "conv",
		iteration: 1,
		toolCallId: "call-1",
		toolName: "editor",
		input: {},
		policy: {},
	}
}

describe("SdkBackgroundSessions", () => {
	let stopSession: Mock<SdkBackgroundSessionsOptions["stopSession"]>
	let notify: Mock<SdkBackgroundSessionsOptions["notify"]>
	let onChanged: Mock<SdkBackgroundSessionsOptions["onChanged"]>
	let recordUsage: Mock<SdkBackgroundSessionsOptions["recordUsage"]>
	let registry: SdkBackgroundSessions

	beforeEach(() => {
		vi.useFakeTimers()
		stopSession = vi.fn<SdkBackgroundSessionsOptions["stopSession"]>(async () => {})
		notify = vi.fn<SdkBackgroundSessionsOptions["notify"]>()
		onChanged = vi.fn<SdkBackgroundSessionsOptions["onChanged"]>()
		recordUsage = vi.fn<SdkBackgroundSessionsOptions["recordUsage"]>()
		registry = new SdkBackgroundSessions({
			stopSession,
			recordUsage,
			notify,
			openTask: vi.fn(),
			onChanged,
			maxSessions: 2,
			idleSettleMs: 100,
		})
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("tracks background tasks up to the limit", () => {
		expect(registry.add(makeSession("a"), "Task A")).toBe(true)
		expect(registry.add(makeSession("b"), "Task B")).toBe(true)
		expect(registry.isFull).toBe(true)
		expect(registry.add(makeSession("c"), "Task C")).toBe(false)
		expect(registry.list()).toEqual([
			{ id: "a", status: "running" },
			{ id: "b", status: "running" },
		])
		expect(registry.has("a")).toBe(true)
		expect(registry.has("c")).toBe(false)
	})

	it("consumes events of background sessions only", () => {
		registry.add(makeSession("a"), "Task A")
		expect(registry.handleEvent(agentEvent("a", { type: "content_start", contentType: "text" }))).toBe(true)
		expect(registry.handleEvent(agentEvent("other", { type: "content_start", contentType: "text" }))).toBe(false)
	})

	it("records usage reported by a background session", () => {
		registry.add(makeSession("a"), "Task A")
		const usage = { type: "usage", inputTokens: 10, outputTokens: 5 }
		registry.handleEvent(agentEvent("a", usage))
		expect(recordUsage).toHaveBeenCalledWith("a", usage)
	})

	it("stops and notifies once the task finishes its turn", async () => {
		const session = makeSession("a")
		registry.add(session, "Fix the build")
		registry.handleEvent(agentEvent("a", { type: "done", reason: "completed" }))

		await vi.advanceTimersByTimeAsync(100)

		expect(stopSession).toHaveBeenCalledWith(session, "backgroundTaskFinished")
		expect(registry.has("a")).toBe(false)
		expect(notify).toHaveBeenCalledWith('PlinyCode task "Fix the build" finished.', expect.any(Function))
	})

	it("reports a failed turn as an error", async () => {
		registry.add(makeSession("a"), "Task A")
		registry.handleEvent(agentEvent("a", { type: "done", reason: "error" }))
		await vi.advanceTimersByTimeAsync(100)
		expect(notify).toHaveBeenCalledWith('PlinyCode task "Task A" stopped with an error.', expect.any(Function))
	})

	it("keeps running while queued prompts remain or a new turn started", async () => {
		registry.add(makeSession("queued", [{ id: "p1" }]), "Queued")
		registry.handleEvent(agentEvent("queued", { type: "done", reason: "completed" }))

		registry.add(makeSession("next"), "Next turn")
		registry.handleEvent(agentEvent("next", { type: "done", reason: "completed" }))
		registry.handleEvent({ type: "pending_prompt_submitted", payload: { sessionId: "next", prompt: "more" } } as never)

		await vi.advanceTimersByTimeAsync(100)

		expect(stopSession).not.toHaveBeenCalled()
		expect(registry.has("queued")).toBe(true)
		expect(registry.has("next")).toBe(true)
	})

	it("ignores done events of sub-agents", async () => {
		registry.add(makeSession("a"), "Task A")
		registry.handleEvent(agentEvent("a", { type: "done", reason: "completed", parentAgentId: "parent" }))
		registry.handleEvent(agentEvent("a", { type: "content_start", contentType: "tool", toolName: "spawn_agent" }))
		registry.handleEvent(agentEvent("a", { type: "done", reason: "completed" }))
		await vi.advanceTimersByTimeAsync(100)
		expect(stopSession).not.toHaveBeenCalled()
	})

	it("holds approvals until the task is taken back, and flags it", async () => {
		registry.add(makeSession("a"), "Task A")
		const result = registry.holdApproval("a", approvalRequest("a"))

		expect(registry.list()).toEqual([{ id: "a", status: "needs_attention" }])
		expect(notify).toHaveBeenCalledWith('PlinyCode task "Task A" needs your approval.', expect.any(Function))

		// A finished turn is not idle while an approval is held.
		registry.handleEvent(agentEvent("a", { type: "done", reason: "completed" }))
		await vi.advanceTimersByTimeAsync(100)
		expect(stopSession).not.toHaveBeenCalled()

		const taken = registry.take("a")
		expect(taken?.held.approvals).toHaveLength(1)
		taken?.held.approvals[0].resolve({ approved: true })
		await expect(result).resolves.toEqual({ approved: true })
		expect(registry.has("a")).toBe(false)
	})

	it("reports whether a taken task had already finished its turn", () => {
		registry.add(makeSession("a"), "Task A")
		expect(registry.take("a")?.turnEnded).toBe(false)

		registry.add(makeSession("b"), "Task B")
		registry.handleEvent(agentEvent("b", { type: "done", reason: "completed" }))
		expect(registry.take("b")?.turnEnded).toBe(true)
	})

	it("rejects held interactions when a task is stopped", async () => {
		const session = makeSession("a")
		registry.add(session, "Task A")
		const approval = registry.holdApproval("a", approvalRequest("a"))
		const answer = registry.holdQuestion("a", "Which one?", [], undefined)

		await registry.stopTask("a", "task deleted")

		await expect(approval).resolves.toEqual({ approved: false, reason: "task deleted" })
		await expect(answer).resolves.toBe("")
		expect(stopSession).toHaveBeenCalledWith(session, "task deleted")
	})

	it("stops every background task", async () => {
		registry.add(makeSession("a"), "Task A")
		registry.add(makeSession("b"), "Task B")
		await registry.stopAll("dispose")
		expect(stopSession).toHaveBeenCalledTimes(2)
		expect(registry.list()).toEqual([])
	})

	it("treats a send settling in the background as a turn end", async () => {
		registry.add(makeSession("a"), "Task A")
		registry.handleSendSettled("a", new Error("boom"))
		await vi.advanceTimersByTimeAsync(100)
		expect(notify).toHaveBeenCalledWith('PlinyCode task "Task A" stopped with an error.', expect.any(Function))
	})
})
