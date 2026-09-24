import type { CoreSessionConfig } from "@plinycode/core"
import { PLINY_FREE_AUTO_MODEL_ID } from "@plinycode/llms"
import type { AgentModel, AgentModelEvent, AgentModelRequest } from "@plinycode/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getSessionState, resetHealth, resetSessions } from "./router-health"
import { installRouter, type RouterInstallDeps } from "./router-integration"

vi.mock("./router-rules-store", async () => {
	const { defaultRules } = await import("./router-rules")
	return { loadRouterRules: vi.fn(async () => defaultRules()) }
})

const NOW = 1_700_000_000_000
const TEXT: AgentModelEvent = { type: "text-delta", text: "hello" }
const STOP: AgentModelEvent = { type: "finish", reason: "stop" }

function scripted(events: AgentModelEvent[]): AgentModel {
	return {
		async *stream() {
			for (const event of events) {
				yield event
			}
		},
	}
}

function request(): AgentModelRequest {
	return { messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] } as never
}

function setup() {
	const rows: string[] = []
	let ts = 0
	const deps: RouterInstallDeps = {
		sessionId: "root",
		getMode: () => "act",
		emitRow: (message) => rows.push(message.text ?? ""),
		nextMessageTs: () => ++ts,
		now: () => NOW,
	}
	const config = installRouter(
		{ providerId: "pliny", modelId: PLINY_FREE_AUTO_MODEL_ID, cwd: "/tmp" } as unknown as CoreSessionConfig,
		deps,
	)
	const factory = config.agentModelFactory
	if (!factory) {
		throw new Error("router did not install a model factory")
	}

	const run = async (agentConfig: { parentAgentId?: string } = {}) => {
		const model = factory({
			config: { modelId: PLINY_FREE_AUTO_MODEL_ID, ...agentConfig } as never,
			createDefault: () => scripted([TEXT, STOP]),
		})
		for await (const _event of await model.stream(request())) {
			// drain
		}
	}
	return { rows, run }
}

describe("installRouter turn isolation", () => {
	beforeEach(() => {
		resetHealth()
		resetSessions()
	})

	it("gives a sub-agent run its own turn instead of resetting the parent's", async () => {
		const { rows, run } = setup()
		await run()
		expect(getSessionState("root").calls).toHaveLength(1)

		await run({ parentAgentId: "parent-agent" })
		expect(getSessionState("root").calls).toHaveLength(1)
		expect(getSessionState("root:sub:1").calls).toHaveLength(1)

		expect(rows[0]).not.toContain("sub-agent")
		expect(rows[1]).toContain("↳ sub-agent")
	})

	it("drops earlier sub-agent state when the next root turn starts", async () => {
		const { run } = setup()
		await run()
		await run({ parentAgentId: "parent-agent" })
		await run({ parentAgentId: "parent-agent" })
		expect(getSessionState("root:sub:1").calls).toHaveLength(1)
		expect(getSessionState("root:sub:2").calls).toHaveLength(1)

		await run()
		expect(getSessionState("root:sub:1").calls).toHaveLength(0)
		expect(getSessionState("root:sub:2").calls).toHaveLength(0)
		expect(getSessionState("root").calls).toHaveLength(1)
	})

	it("passes a concrete model straight through", () => {
		const { rows } = setup()
		const config = installRouter(
			{ providerId: "pliny", modelId: "snps-provider/kimi-k2.6", cwd: "/tmp" } as unknown as CoreSessionConfig,
			{ sessionId: "other", getMode: () => "act", emitRow: () => undefined, nextMessageTs: () => 1 },
		)
		const createDefault = vi.fn(() => scripted([STOP]))
		config.agentModelFactory?.({ config: { modelId: "snps-provider/kimi-k2.6" } as never, createDefault })
		expect(createDefault).toHaveBeenCalledWith()
		expect(rows).toEqual([])
	})
})
