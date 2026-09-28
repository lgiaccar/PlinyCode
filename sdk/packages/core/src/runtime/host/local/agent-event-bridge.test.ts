import type { AgentEvent } from "@plinycode/shared";
import { describe, expect, it, vi } from "vitest";
import type { CoreSessionConfig } from "../../../types/config";
import type { CoreSessionEvent } from "../../../types/events";
import type { ActiveSession } from "../../../types/session";
import {
	AgentEventBridge,
	type AgentEventBridgeDeps,
} from "./agent-event-bridge";

describe("AgentEventBridge.dispatchAgentEvent", () => {
	function createDispatchFixture() {
		const config = {
			providerId: "cline",
			modelId: "model-a",
			mode: "act",
		} as unknown as CoreSessionConfig;
		const session = {
			config,
			agent: {
				getAgentId: () => "agent-1",
				getConversationId: () => "conv-1",
			},
			runtime: { teamRuntime: {} },
		} as unknown as ActiveSession;
		const sessions = new Map<string, ActiveSession>([["session-1", session]]);
		const emit = vi.fn<(event: CoreSessionEvent) => void>();
		const deps = {
			getSession: (sessionId: string) => sessions.get(sessionId),
			usageBySession: new Map(),
			aggregateUsageBySession: new Map(),
			emit,
			persistMessages: vi.fn(),
		} as unknown as AgentEventBridgeDeps;
		return { config, sessions, emit, bridge: new AgentEventBridge(deps) };
	}

	const toolEvent = {
		type: "content_end",
		contentType: "tool",
		toolName: "run_commands",
	} as unknown as AgentEvent;

	function lastAgentEventPayload(
		emit: ReturnType<typeof vi.fn<(event: CoreSessionEvent) => void>>,
	) {
		const event = emit.mock.calls
			.map(([arg]) => arg)
			.filter((arg) => arg.type === "agent_event")
			.at(-1);
		expect(event).toBeDefined();
		return event?.payload as Record<string, unknown>;
	}

	it("tags events from a registered team lead session with the lead role", () => {
		const { config, emit, bridge } = createDispatchFixture();

		bridge.dispatchAgentEvent("session-1", config, toolEvent);

		expect(lastAgentEventPayload(emit)).toMatchObject({
			sessionId: "session-1",
			teamRole: "lead",
		});
	});

	it("keeps the last known identity for events dispatched after the session was deregistered", () => {
		const { config, sessions, emit, bridge } = createDispatchFixture();

		// A live event records the identity snapshot...
		bridge.dispatchAgentEvent("session-1", config, toolEvent);

		// ...then teardown removes the session from the map while the agent's
		// run is still draining (sessions.delete precedes shutdown completion).
		sessions.delete("session-1");
		bridge.dispatchAgentEvent("session-1", config, toolEvent);

		expect(lastAgentEventPayload(emit)).toMatchObject({
			sessionId: "session-1",
			teamRole: "lead",
		});
	});

	it("emits without a team role when a session was never registered (no snapshot to reuse)", () => {
		const { config, emit, bridge } = createDispatchFixture();

		bridge.dispatchAgentEvent("session-unknown", config, toolEvent);

		const payload = lastAgentEventPayload(emit);
		expect(payload.sessionId).toBe("session-unknown");
		expect(payload.teamRole).toBeUndefined();
	});
});
