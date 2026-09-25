import type { CoreSessionConfig } from "@plinycode/core"
import { PLINY_BALANCE_AUTO_MODEL_ID, PLINY_FREE_AUTO_MODEL_ID } from "@plinycode/llms"
import type { AgentMessage, AgentModel, AgentModelEvent, AgentModelRequest } from "@plinycode/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RouterCallLogRecord } from "./router-call-log"
import { getSessionState, resetHealth, resetSessions } from "./router-health"
import { installRouter, type RouterInstallDeps } from "./router-integration"
import type { RouterRunLogRecord } from "./router-run-log"

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

function assistant(text: string, id = "a"): AgentMessage {
	return { id, role: "assistant", content: [{ type: "text", text }], createdAt: 0 }
}

function toolResult(toolName: string, output: unknown, id = "t"): AgentMessage {
	return { id, role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName, output }], createdAt: 0 }
}

describe("installRouter completion guard", () => {
	beforeEach(() => {
		resetHealth()
		resetSessions()
	})

	const unfinished = { message: assistant("Let me check the log:"), iteration: 3 }

	function install(modelId: string = PLINY_FREE_AUTO_MODEL_ID) {
		const rows: string[] = []
		const runs: RouterRunLogRecord[] = []
		const config = installRouter({ providerId: "pliny", modelId, cwd: "/tmp" } as unknown as CoreSessionConfig, {
			sessionId: "s",
			getMode: () => "act",
			emitRow: (message) => rows.push(message.text ?? ""),
			nextMessageTs: () => 1,
			logCall: () => undefined,
			logRun: (record) => runs.push(record),
			now: () => NOW,
		})
		return { config, rows, runs }
	}

	it("nudges a free model that announced a step without acting, and says so in the chat", async () => {
		const { config, rows } = install()
		expect(await config.completionGuard?.(unfinished)).toContain("did not call a tool")
		expect(rows[0]).toContain("stopped after")
		expect(rows[0]).toContain("rule: announcement")
	})

	it("stays out of the way for a paid hosted model", async () => {
		const { config } = install("snps-aws-bedrock/aws-claude-sonnet-4.6")
		expect(await config.completionGuard?.(unfinished)).toBeUndefined()
	})

	it("escalates on a second consecutive stall and switches the turn to another model", async () => {
		const { config, rows } = install()
		const state = getSessionState("s")
		state.calls.push({ modelId: "snps-provider/kimi-k2.6", startedAt: NOW, routeName: "default" })
		state.stickyModelId = "snps-provider/kimi-k2.6"

		expect(await config.completionGuard?.({ ...unfinished, iteration: 3 })).toContain("did not call a tool")
		expect(await config.completionGuard?.({ ...unfinished, iteration: 4 })).toContain("Second reminder")
		expect(state.stickyModelId).toBe("snps-provider/qwen3-coder-480b-a35b-inst-fp8")
		expect(rows.some((row) => row.includes("switching to **qwen3-coder-480b-a35b-inst-fp8**"))).toBe(true)
		expect(state.run.escalated).toBe(true)
		expect(state.run.guardRules).toEqual(["announcement", "announcement"])
		// A third stall in a row is taken at its word.
		expect(await config.completionGuard?.({ ...unfinished, iteration: 5 })).toBeUndefined()
	})

	it("appends a note to a failed shell result and remembers it for the guard", async () => {
		const { config } = install()
		const afterTool = config.hooks?.afterTool
		if (!afterTool) {
			throw new Error("router did not install an afterTool hook")
		}
		const result = await afterTool({
			snapshot: { agentId: "root", iteration: 2 } as never,
			tool: { name: "run_commands" } as never,
			toolCall: { type: "tool-call", toolCallId: "c1", toolName: "run_commands", input: {} },
			input: {},
			result: {
				output: [
					{
						query: "bun test",
						result: "[Command exited with code 1]\n1 failed",
						error: "Command exited with code 1",
						success: false,
					},
				],
			},
			startedAt: new Date(NOW),
			endedAt: new Date(NOW),
			durationMs: 0,
		})
		expect(result?.appendContext).toContain("failed with exit code 1")
		expect(result?.appendContext).toContain("`bun test`")
		const run = getSessionState("s").run
		expect(run).toMatchObject({
			toolCalls: 1,
			previousTool: "run_commands",
			previousToolFailed: true,
			previousToolDetached: false,
		})
	})

	it("adds nothing to a successful result, but still counts the tool call", async () => {
		const { config } = install()
		const result = await config.hooks?.afterTool?.({
			snapshot: { agentId: "root", iteration: 2 } as never,
			tool: { name: "read_files" } as never,
			toolCall: { type: "tool-call", toolCallId: "c1", toolName: "read_files", input: {} },
			input: {},
			result: { output: "contents" },
			startedAt: new Date(NOW),
			endedAt: new Date(NOW),
			durationMs: 0,
		})
		expect(result).toBeUndefined()
		expect(getSessionState("s").run.toolCalls).toBe(1)
	})

	it("nudges a reply that ends right after a failed command, naming the exit code", async () => {
		const { config, rows } = install()
		const reply = assistant("The build fails because libfoo is missing from the link line.")
		const runMessages = [
			toolResult("run_commands", [
				{ query: "make", result: "[Command exited with code 2]", error: "Command exited with code 2", success: false },
			]),
			reply,
		]
		const reminder = await config.completionGuard?.({ message: reply, iteration: 2, runMessages, messages: runMessages })
		expect(reminder).toContain("exit code 2")
		expect(rows[0]).toContain("rule: after-failed-command")
	})

	it("writes one run record when a routed run ends on a tool-free reply", async () => {
		const { config, runs } = install()
		const state = getSessionState("s")
		state.calls.push({ modelId: "snps-provider/kimi-k2.6", startedAt: NOW, routeName: "coding" })
		state.run.toolCalls = 4
		state.run.previousTool = "run_commands"
		state.run.guardRules.push("announcement")
		state.run.nudges = 1
		await config.hooks?.afterRun?.({
			snapshot: { agentId: "root", iteration: 5 } as never,
			result: {
				agentId: "root",
				runId: "r1",
				status: "completed",
				iterations: 5,
				outputText: "Done.",
				messages: [assistant("All tests pass. Done.")],
				usage: {} as never,
			},
		})
		expect(runs).toEqual([
			expect.objectContaining({
				sessionId: "s",
				subAgent: false,
				profile: "default",
				model: "snps-provider/kimi-k2.6",
				route: "coding",
				calls: 1,
				iterations: 5,
				ending: "text",
				toolCalls: 4,
				previousTool: "run_commands",
				guardRules: ["announcement"],
				nudges: 1,
				replyChars: 21,
				replyTail: "All tests pass. Done.",
			}),
		])
	})

	it("records a completion-tool ending and skips the run log for a concrete model", async () => {
		const { config, runs } = install()
		await config.hooks?.afterRun?.({
			snapshot: { agentId: "root", iteration: 1 } as never,
			result: {
				agentId: "root",
				runId: "r1",
				status: "completed",
				iterations: 1,
				outputText: "",
				messages: [
					{
						id: "a",
						role: "assistant",
						content: [{ type: "tool-call", toolCallId: "c", toolName: "submit_and_exit", input: {} }],
						createdAt: 0,
					},
				],
				usage: {} as never,
			},
		})
		expect(runs[0]?.ending).toBe("completion-tool")

		const direct = install("snps-provider/kimi-k2.6")
		await direct.config.hooks?.afterRun?.({
			snapshot: { agentId: "root", iteration: 1 } as never,
			result: {
				agentId: "root",
				runId: "r2",
				status: "completed",
				iterations: 1,
				outputText: "",
				messages: [],
				usage: {} as never,
			},
		})
		expect(direct.runs).toHaveLength(0)
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

	it("records why the classifier gave no verdict on the turn's first call", async () => {
		const { rows, logged, run, classifierModel } = setup("pliny/free-auto-smart")
		classifierModel.mockReturnValueOnce(scripted([{ type: "text-delta", text: "I believe this is a coding task, so" }, STOP]))
		await run({}, 2)
		expect(rows[0]).toContain("classifier gave no verdict")
		expect(logged[0]?.classifierError).toContain("unusable reply")
		expect(logged[0]?.tier).toBeUndefined()
		expect(logged[1]?.classifierError).toBeUndefined()
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
		const { rows, run, config, classifierModel } = setup(PLINY_BALANCE_AUTO_MODEL_ID)
		// Nothing has run yet: no model to blame, so no nudge.
		expect(await config.completionGuard?.(UNFINISHED_REPLY)).toBeUndefined()

		await run()
		// The paid model handled the turn; it does not stop early.
		expect(await config.completionGuard?.(UNFINISHED_REPLY)).toBeUndefined()

		// The guard only ever judges the root agent's reply (sub-agents get no
		// completion policy), so a free sub-agent run must not make a paid root
		// reply look like a free model's.
		await run({ parentAgentId: "parent" })
		expect(await config.completionGuard?.(UNFINISHED_REPLY)).toBeUndefined()

		// A root turn the classifier sends to a free model is nudged.
		classifierModel.mockReturnValueOnce(scripted([{ type: "text-delta", text: '{"tier":"quick","think":false}' }, STOP]))
		await run()
		expect(rows[rows.length - 1]).toContain("BalanceAuto → **kimi-k2.6**")
		expect(await config.completionGuard?.({ ...UNFINISHED_REPLY, iteration: 1 })).toContain("did not call a tool")
		expect(rows[rows.length - 1]).toContain("stopped after")
	})

	it("adds the failed-command note on BalanceAuto only for a tool a free model ran", async () => {
		const { run, config } = setup(PLINY_BALANCE_AUTO_MODEL_ID)
		const failedShell = (parentAgentId?: string) =>
			config.hooks?.afterTool?.({
				snapshot: { agentId: "a", iteration: 1, ...(parentAgentId ? { parentAgentId } : {}) } as never,
				tool: { name: "run_commands" } as never,
				toolCall: { type: "tool-call", toolCallId: "c1", toolName: "run_commands", input: {} },
				input: {},
				result: { output: [{ query: "make", result: "", error: "Command exited with code 2", success: false }] },
				startedAt: new Date(NOW),
				endedAt: new Date(NOW),
				durationMs: 0,
			})

		await run()
		// Root turn on the paid model: no note.
		expect(await failedShell()).toBeUndefined()

		await run({ parentAgentId: "parent" })
		// The sub-agent's tool ran under a free model: note added.
		expect((await failedShell("parent"))?.appendContext).toContain("exit code 2")
		// The root agent is still on the paid model.
		expect(await failedShell()).toBeUndefined()
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
