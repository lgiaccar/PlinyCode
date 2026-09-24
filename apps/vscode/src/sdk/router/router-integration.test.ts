import type { CoreSessionConfig } from "@plinycode/core"
import { PLINY_BALANCE_AUTO_MODEL_ID, PLINY_FREE_AUTO_MODEL_ID } from "@plinycode/llms"
import type { AgentModel, AgentModelEvent, AgentModelRequest } from "@plinycode/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RouterCallLogRecord } from "./router-call-log"
import { getSessionState, resetHealth, resetSessions } from "./router-health"
import { installRouter, type RouterInstallDeps } from "./router-integration"

vi.mock("./router-rules-store", async () => {
	const { defaultRules } = await import("./router-rules")
	return { loadRouterRules: vi.fn(async (options?: { profile?: string }) => defaultRules(options?.profile)) }
})

const NOW = 1_700_000_000_000
const TEXT: AgentModelEvent = { type: "text-delta", text: "hello" }
const STOP: AgentModelEvent = { type: "finish", reason: "stop" }
const CLASSIFIER = "snps-provider/qwen3-6-35b-a3b-1-28dd3"

function scripted(events: AgentModelEvent[]): AgentModel {
	return {
		async *stream() {
			for (const event of events) {
				yield event
			}
		},
	}
}

function request(text = "fix the failing test"): AgentModelRequest {
	return { messages: [{ id: "m1", role: "user", content: [{ type: "text", text }], createdAt: 0 }], tools: [] }
}

function setup(modelId: string = PLINY_FREE_AUTO_MODEL_ID) {
	const rows: string[] = []
	const logged: RouterCallLogRecord[] = []
	let ts = 0
	const deps: RouterInstallDeps = {
		sessionId: "root",
		getMode: () => "act",
		emitRow: (message) => rows.push(message.text ?? ""),
		nextMessageTs: () => ++ts,
		logCall: (record) => logged.push(record),
		now: () => NOW,
	}
	const config = installRouter({ providerId: "pliny", modelId, cwd: "/tmp" } as unknown as CoreSessionConfig, deps)
	const factory = config.agentModelFactory
	if (!factory) {
		throw new Error("router did not install a model factory")
	}

	const createdFor: string[] = []
	const classifierModel = vi.fn(() => scripted([{ type: "text-delta", text: '{"tier":"code","think":false}' }, STOP]))
	const run = async (agentConfig: { parentAgentId?: string } = {}, calls = 1) => {
		const model = factory({
			config: { modelId, ...agentConfig } as never,
			createDefault: (overrides) => {
				createdFor.push(overrides?.modelId ?? "(default)")
				return overrides?.modelId === CLASSIFIER ? classifierModel() : scripted([TEXT, STOP])
			},
		})
		for (let call = 0; call < calls; call += 1) {
			for await (const _event of await model.stream(request())) {
				// drain
			}
		}
	}
	return { rows, logged, run, createdFor, classifierModel, config }
}

const UNFINISHED_REPLY = {
	message: {
		id: "a",
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "Let me check the log:" }],
		createdAt: 0,
	},
	iteration: 3,
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

describe("installRouter unfinished-turn guard", () => {
	const unfinished = {
		message: {
			id: "a",
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Let me check the log:" }],
			createdAt: 0,
		},
		iteration: 3,
	}

	it("nudges a free model that announced a step without acting, and says so in the chat", () => {
		const rows: string[] = []
		const config = installRouter(
			{ providerId: "pliny", modelId: PLINY_FREE_AUTO_MODEL_ID, cwd: "/tmp" } as unknown as CoreSessionConfig,
			{
				sessionId: "s",
				getMode: () => "act",
				emitRow: (message) => rows.push(message.text ?? ""),
				nextMessageTs: () => 1,
				logCall: () => undefined,
			},
		)
		expect(config.completionGuard?.(unfinished)).toContain("did not call a tool")
		expect(rows[0]).toContain("stopped after")
	})

	it("stays out of the way for a paid hosted model", () => {
		const config = installRouter(
			{
				providerId: "pliny",
				modelId: "snps-aws-bedrock/aws-claude-sonnet-4.6",
				cwd: "/tmp",
			} as unknown as CoreSessionConfig,
			{ sessionId: "s", getMode: () => "act", emitRow: () => undefined, nextMessageTs: () => 1 },
		)
		expect(config.completionGuard?.(unfinished)).toBeUndefined()
	})
})

describe("installRouter profiles, effort and call log", () => {
	beforeEach(() => {
		resetHealth()
		resetSessions()
	})

	it("names a non-default profile and the effort it applied in the routing row", async () => {
		const { rows, run } = setup("pliny/free-auto-fast")
		await run()
		// "fix the failing test" hits the coding route, whose first model never reasons: quick is applied.
		expect(rows[0]).toContain("FreeAuto·fast → **qwen3-coder-480b-a35b-inst-fp8**")
		expect(rows[0]).toContain("route: coding · quick")
	})

	it("logs one record per attempt with profile, route, effort and timing", async () => {
		const { logged, run } = setup()
		await run()
		expect(logged).toEqual([
			expect.objectContaining({
				sessionId: "root",
				subAgent: false,
				profile: "default",
				route: "coding",
				effort: "quick",
				model: "snps-provider/qwen3-coder-480b-a35b-inst-fp8",
				outcome: "success",
				durationMs: 0,
				ttftMs: 0,
			}),
		])
	})

	it("runs the smart profile's classifier once per turn and reuses its verdict", async () => {
		const { rows, logged, run, classifierModel } = setup("pliny/free-auto-smart")
		await run({}, 3)
		expect(classifierModel).toHaveBeenCalledTimes(1)
		expect(rows[0]).toContain("classifier: code")
		expect(logged.every((record) => record.tier === "code" && record.think === false)).toBe(true)
		expect(logged).toHaveLength(3)

		await run()
		expect(classifierModel).toHaveBeenCalledTimes(2)
	})

	it("routes BalanceAuto's coding work to the paid model and its sub-agents to a free one", async () => {
		const { rows, logged, run, classifierModel } = setup(PLINY_BALANCE_AUTO_MODEL_ID)
		await run()
		expect(classifierModel).toHaveBeenCalledTimes(1)
		expect(rows[0]).toContain("BalanceAuto → **global.anthropic.claude-sonnet-5**")
		expect(rows[0]).toContain("route: coding")
		expect(rows[0]).toContain("classifier: code")

		await run({ parentAgentId: "parent" })
		expect(rows[1]).toContain("↳ sub-agent BalanceAuto → **kimi-k2.6**")
		expect(rows[1]).toContain("route: subagent")

		expect(logged.map((record) => [record.profile, record.subAgent, record.model])).toEqual([
			["balance", false, "snps-aws-bedrock/global.anthropic.claude-sonnet-5"],
			["balance", true, "snps-provider/kimi-k2.6"],
		])
	})

	it("nudges an unfinished BalanceAuto reply only when a free model wrote it", async () => {
		const { rows, run, config } = setup(PLINY_BALANCE_AUTO_MODEL_ID)
		// Nothing has run yet: no model to blame, so no nudge.
		expect(config.completionGuard?.(UNFINISHED_REPLY)).toBeUndefined()

		await run()
		// The paid model handled the turn; it does not stop early.
		expect(config.completionGuard?.(UNFINISHED_REPLY)).toBeUndefined()

		await run({ parentAgentId: "parent" })
		// The sub-agent ran on a free model, which does.
		expect(config.completionGuard?.(UNFINISHED_REPLY)).toContain("did not call a tool")
		expect(rows[rows.length - 1]).toContain("stopped after")
	})

	it("never classifies a sub-agent call, nor anything on the default profile", async () => {
		const smart = setup("pliny/free-auto-smart")
		await smart.run({ parentAgentId: "parent" })
		expect(smart.classifierModel).not.toHaveBeenCalled()

		const plain = setup()
		await plain.run()
		expect(plain.createdFor).not.toContain(CLASSIFIER)
	})
})
