import type { CoreSessionConfig } from "@plinycode/core"
import { PLINY_BALANCE_AUTO_MODEL_ID, PLINY_FREE_AUTO_MODEL_ID } from "@plinycode/llms"
import type { AgentMessage, AgentModel, AgentModelEvent, AgentModelRequest } from "@plinycode/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RouterCallLogRecord } from "./router-call-log"
import { getSessionState, isModelHealthy, resetHealth, resetSessions } from "./router-health"
import { installRouter, type RouterInstallDeps } from "./router-integration"
import { defaultRules } from "./router-rules"
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

function setup(modelId: string = PLINY_FREE_AUTO_MODEL_ID, knownModels?: Record<string, { name: string }>) {
	const rows: string[] = []
	const logged: RouterCallLogRecord[] = []
	const sleeps: number[] = []
	let ts = 0
	const deps: RouterInstallDeps = {
		sessionId: "root",
		getMode: () => "act",
		emitRow: (message) => rows.push(message.text ?? ""),
		nextMessageTs: () => ++ts,
		logCall: (record) => logged.push(record),
		now: () => NOW,
		sleep: async (ms) => {
			sleeps.push(ms)
		},
	}
	const config = installRouter({ providerId: "pliny", modelId, cwd: "/tmp", knownModels } as unknown as CoreSessionConfig, deps)
	const factory = config.agentModelFactory
	if (!factory) {
		throw new Error("router did not install a model factory")
	}

	const createdFor: string[] = []
	const classifierModel = vi.fn(() => scripted([{ type: "text-delta", text: '{"tier":"code","think":false}' }, STOP]))
	const run = async (agentConfig: { parentAgentId?: string; agentId?: string } = {}, calls = 1) => {
		const { agentId, ...rest } = agentConfig
		const model = factory({
			config: { modelId, ...rest } as never,
			...(agentId ? { agentId } : {}),
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
	return { rows, logged, run, createdFor, classifierModel, config, sleeps }
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

	it("keys parallel sub-agent runs by agent id, so a failure benches the run that failed", async () => {
		const { run, config } = setup()
		await run()
		await run({ parentAgentId: "parent", agentId: "sub-a" })
		await run({ parentAgentId: "parent", agentId: "sub-b" })
		expect(getSessionState("root:sub:1").calls).toHaveLength(1)
		expect(getSessionState("root:sub:2").calls).toHaveLength(1)

		// The first sub-agent fails after the second one ran: its own turn takes the failover.
		const decision = await config.onRunError?.({
			error: "boom",
			attempt: 1,
			modelId: PLINY_FREE_AUTO_MODEL_ID,
			hadAssistantContent: false,
			agentId: "sub-a",
			parentAgentId: "parent",
		})
		expect(decision).toMatchObject({ retry: true })
		expect(getSessionState("root:sub:1").failovers).toBe(1)
		expect(getSessionState("root:sub:2").failovers).toBe(0)
		expect(getSessionState("root").failovers).toBe(0)

		// Its retry continues its own turn; the next root run still starts a new one.
		await run({ parentAgentId: "parent", agentId: "sub-a" })
		expect(getSessionState("root:sub:1").calls).toHaveLength(2)
		await run({ agentId: "root-agent" })
		expect(getSessionState("root").calls).toHaveLength(1)
		expect(getSessionState("root:sub:1").calls).toHaveLength(0)
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
		// A third stall in a row is taken at its word, and the chat says so.
		expect(await config.completionGuard?.({ ...unfinished, iteration: 5 })).toBeUndefined()
		expect(state.run.guardGaveUp).toBe("repeated-stall")
		expect(rows.at(-1)).toContain("not asking again: it stalled three times in a row")
	})

	it("switches away from a model that stalls between every step, even though it acts when reminded", async () => {
		const { config, rows } = install()
		const state = getSessionState("s")
		state.calls.push({ modelId: "snps-provider/kimi-k2.6", startedAt: NOW, routeName: "default" })
		state.stickyModelId = "snps-provider/kimi-k2.6"

		expect(await config.completionGuard?.({ ...unfinished, iteration: 1 })).toContain("did not call a tool")
		state.run.toolCalls += 1
		expect(await config.completionGuard?.({ ...unfinished, iteration: 3 })).toContain("did not call a tool")
		state.run.toolCalls += 1
		expect(await config.completionGuard?.({ ...unfinished, iteration: 5 })).toContain("stopped several times")
		expect(state.stickyModelId).toBe("snps-provider/qwen3-coder-480b-a35b-inst-fp8")
		expect(state.run.escalated).toBe(true)
		expect(state.run.guardGaveUp).toBeUndefined()
		expect(rows.at(-2)).toContain("(3/8)")
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
		expect(result?.appendContext).toContain("exited with code 1")
		expect(result?.appendContext).toContain("`bun test`")
		const run = getSessionState("s").run
		expect(run).toMatchObject({
			toolCalls: 1,
			previousTool: "run_commands",
			previousToolFailed: true,
			previousToolDetached: false,
		})
	})

	it("notes at most two shell failures per run and none for a quiet query exit", async () => {
		const { config } = install()
		const afterTool = config.hooks?.afterTool
		if (!afterTool) {
			throw new Error("router did not install an afterTool hook")
		}
		const failed = (query: string, result: string, runId = "run-1") =>
			afterTool({
				snapshot: { agentId: "root", runId, iteration: 2 } as never,
				tool: { name: "run_commands" } as never,
				toolCall: { type: "tool-call", toolCallId: "c1", toolName: "run_commands", input: {} },
				input: {},
				result: { output: [{ query, result, error: "Command exited with code 1", success: false }] },
				startedAt: new Date(NOW),
				endedAt: new Date(NOW),
				durationMs: 0,
			})
		// findstr with no match: not a failure, no note, not counted.
		expect(await failed("findstr ZLIB CMakeLists.txt", "[Command exited with code 1]")).toBeUndefined()
		expect(getSessionState("s").run.previousToolFailed).toBe(false)
		expect((await failed("bun test", "[Command exited with code 1]\n1 failed"))?.appendContext).toContain("`bun test`")
		expect((await failed("bun lint", "[Command exited with code 1]\n2 errors"))?.appendContext).toContain("`bun lint`")
		// The third failure of the run gets no note; the state still counts it.
		expect(await failed("bun build", "[Command exited with code 1]\nboom")).toBeUndefined()
		expect(getSessionState("s").run.failedCommands).toBe(3)
		// A new run starts over.
		expect((await failed("bun test", "[Command exited with code 1]\n1 failed", "run-2"))?.appendContext).toContain(
			"exited with code 1",
		)
	})

	it("escalates a BalanceAuto stall to a free model first and to the default lead only the second time", async () => {
		const { config, rows } = install(PLINY_BALANCE_AUTO_MODEL_ID)
		const state = getSessionState("s")
		state.calls.push({ modelId: "snps-provider/kimi-k2.6", startedAt: NOW, routeName: "coding" })
		state.stickyModelId = "snps-provider/kimi-k2.6"

		expect(await config.completionGuard?.({ ...unfinished, iteration: 3 })).toContain("did not call a tool")
		expect(await config.completionGuard?.({ ...unfinished, iteration: 4 })).toContain("Second reminder")
		expect(state.stickyModelId).toBe("snps-provider/qwen3-coder-480b-a35b-inst-fp8")
		expect(state.run.escalatedTo).toBe("snps-provider/qwen3-coder-480b-a35b-inst-fp8")
		expect(state.escalations).toBe(1)

		// The coder acts on the reminder, then stalls again and again: the turn goes to paid Claude.
		state.calls.push({ modelId: "snps-provider/qwen3-coder-480b-a35b-inst-fp8", startedAt: NOW, routeName: "coding" })
		state.run.toolCalls += 1
		expect(await config.completionGuard?.({ ...unfinished, iteration: 6 })).toContain("did not call a tool")
		state.run.toolCalls += 1
		expect(await config.completionGuard?.({ ...unfinished, iteration: 8 })).toContain("did not call a tool")
		state.run.toolCalls += 1
		expect(await config.completionGuard?.({ ...unfinished, iteration: 10 })).toContain("stopped several times")
		expect(state.stickyModelId).toBe("snps-aws-bedrock/global.anthropic.claude-sonnet-5")
		expect(state.escalations).toBe(2)
		expect(rows.some((row) => row.includes("switching to **qwen3-coder-480b-a35b-inst-fp8**"))).toBe(true)
		expect(rows.some((row) => row.includes("switching to **global.anthropic.claude-sonnet-5**"))).toBe(true)
	})

	it("sends six failed commands on BalanceAuto straight to the default route's lead", async () => {
		const { config } = install(PLINY_BALANCE_AUTO_MODEL_ID)
		const state = getSessionState("s")
		state.calls.push({ modelId: "snps-provider/kimi-k2.6", startedAt: NOW, routeName: "coding" })
		state.stickyModelId = "snps-provider/kimi-k2.6"
		for (let i = 1; i <= 6; i += 1) {
			await config.hooks?.afterTool?.({
				snapshot: { agentId: "root", iteration: 2 } as never,
				tool: { name: "run_commands" } as never,
				toolCall: { type: "tool-call", toolCallId: `c${i}`, toolName: "run_commands", input: {} },
				input: {},
				result: {
					output: [
						{
							query: "build",
							result: "[Command exited with code 1]",
							error: "Command exited with code 1",
							success: false,
						},
					],
				},
				startedAt: new Date(NOW),
				endedAt: new Date(NOW),
				durationMs: 0,
			})
		}
		expect(state.stickyModelId).toBe("snps-aws-bedrock/global.anthropic.claude-sonnet-5")
		expect(state.run.escalatedTo).toBe("snps-aws-bedrock/global.anthropic.claude-sonnet-5")
	})

	it("moves the turn to the default route's lead after six failed commands, once", async () => {
		const { config, rows } = install()
		const state = getSessionState("s")
		state.calls.push({ modelId: "snps-provider/kimi-k2.6", startedAt: NOW, routeName: "default" })
		state.stickyModelId = "snps-provider/kimi-k2.6"
		const failCommand = (id: string) =>
			config.hooks?.afterTool?.({
				snapshot: { agentId: "root", iteration: 2 } as never,
				tool: { name: "run_commands" } as never,
				toolCall: { type: "tool-call", toolCallId: id, toolName: "run_commands", input: {} },
				input: {},
				result: {
					output: [
						{
							query: "build",
							result: "[Command exited with code 1]",
							error: "Command exited with code 1",
							success: false,
						},
					],
				},
				startedAt: new Date(NOW),
				endedAt: new Date(NOW),
				durationMs: 0,
			})
		for (let i = 1; i <= 5; i += 1) {
			await failCommand(`c${i}`)
		}
		expect(state.stickyModelId).toBe("snps-provider/kimi-k2.6")
		expect(state.run.escalated).toBeFalsy()

		await failCommand("c6")
		expect(state.run.failedCommands).toBe(6)
		expect(state.run.escalated).toBe(true)
		expect(state.stickyModelId).toBe("snps-provider/qwen3-coder-480b-a35b-inst-fp8")
		expect(rows.some((row) => row.includes("6 commands have failed this turn"))).toBe(true)
		expect(rows.some((row) => row.includes("switching to **qwen3-coder-480b-a35b-inst-fp8**"))).toBe(true)

		// Later failures do not switch again.
		const switchRows = rows.filter((row) => row.includes("switching to")).length
		await failCommand("c7")
		expect(rows.filter((row) => row.includes("switching to")).length).toBe(switchRows)
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
		const { rows, run } = setup("pliny/auto-free-fast")
		await run()
		// "fix the failing test" hits the coding route, whose first model never reasons: quick is applied.
		expect(rows[0]).toContain("auto-free-fast → **qwen3-coder-480b-a35b-inst-fp8**")
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
				// kimi has no measured reasoning switch, so the route's "quick" is
				// not applied to it and the record carries no effort.
				model: "snps-provider/kimi-k2.6",
				outcome: "success",
				durationMs: 0,
				ttftMs: 0,
				finishReason: "stop",
				textChars: 5,
				reasoningChars: 0,
				toolCalls: 0,
			}),
		])
	})

	it("runs the smart profile's classifier once per turn and reuses its verdict", async () => {
		const { rows, logged, run, classifierModel } = setup("pliny/auto-free-smart")
		await run({}, 3)
		expect(classifierModel).toHaveBeenCalledTimes(1)
		expect(rows[0]).toContain("classifier: code")
		expect(logged.every((record) => record.tier === "code" && record.think === false)).toBe(true)
		expect(logged).toHaveLength(3)

		await run()
		expect(classifierModel).toHaveBeenCalledTimes(2)
	})

	it("records why the classifier gave no verdict on the turn's first call", async () => {
		const { rows, logged, run, classifierModel } = setup("pliny/auto-free-smart")
		classifierModel.mockReturnValueOnce(scripted([{ type: "text-delta", text: "I believe this is a coding task, so" }, STOP]))
		await run({}, 2)
		expect(rows[0]).toContain("classifier gave no verdict")
		expect(logged[0]?.classifierError).toContain("unusable reply")
		expect(logged[0]?.tier).toBeUndefined()
		expect(logged[1]?.classifierError).toBeUndefined()
	})

	it("routes BalanceAuto's coding work and sub-agents to free models, and reasoning to paid Claude", async () => {
		const { rows, logged, run, classifierModel } = setup(PLINY_BALANCE_AUTO_MODEL_ID)
		await run()
		expect(classifierModel).toHaveBeenCalledTimes(1)
		expect(rows[0]).toContain("auto-paid-balanced → **kimi-k2.6**")
		expect(rows[0]).toContain("route: coding")
		expect(rows[0]).toContain("classifier: code")

		await run({ parentAgentId: "parent" })
		expect(rows[1]).toContain("↳ sub-agent auto-paid-balanced → **kimi-k2.6**")
		expect(rows[1]).toContain("route: subagent")

		classifierModel.mockReturnValueOnce(scripted([{ type: "text-delta", text: '{"tier":"reason","think":true}' }, STOP]))
		await run()
		expect(rows[2]).toContain("auto-paid-balanced → **claude-4-6-sonnet-high-thinking**")
		expect(rows[2]).toContain("route: plan-and-reasoning")

		expect(logged.map((record) => [record.profile, record.subAgent, record.model])).toEqual([
			["balance", false, "snps-provider/kimi-k2.6"],
			["balance", true, "snps-provider/kimi-k2.6"],
			["balance", false, "aws-bedrock-vmodels/claude-4-6-sonnet-high-thinking"],
		])
	})

	it("moves a BalanceAuto turn to a free model once it has spent its paid calls", async () => {
		const { loadRouterRules } = await import("./router-rules-store")
		const balance = defaultRules("balance")
		vi.mocked(loadRouterRules).mockImplementation(async (options?: { profile?: string }) =>
			options?.profile === "balance"
				? { ...balance, health: { ...balance.health, maxPaidCallsPerTurn: 2 } }
				: defaultRules(options?.profile),
		)
		try {
			const { rows, logged, run, classifierModel } = setup(PLINY_BALANCE_AUTO_MODEL_ID)
			classifierModel.mockReturnValue(scripted([{ type: "text-delta", text: '{"tier":"reason","think":true}' }, STOP]))
			await run({}, 3)
			expect(logged.map((record) => record.model)).toEqual([
				"aws-bedrock-vmodels/claude-4-6-sonnet-high-thinking",
				"aws-bedrock-vmodels/claude-4-6-sonnet-high-thinking",
				"snps-provider/kimi-k2.6",
			])
			expect(rows.some((row) => row.includes("2 paid calls this turn (health.maxPaidCallsPerTurn: 2)"))).toBe(true)
			expect(rows.some((row) => row.includes("switching to **kimi-k2.6**"))).toBe(true)
			expect(getSessionState("root").run.paidCapHit).toBe(true)

			// Once per turn: the next turn starts afresh on the paid model.
			await run()
			expect(logged.at(-1)?.model).toBe("aws-bedrock-vmodels/claude-4-6-sonnet-high-thinking")
		} finally {
			vi.mocked(loadRouterRules).mockImplementation(async (options?: { profile?: string }) =>
				defaultRules(options?.profile),
			)
		}
	})

	it("never caps paid calls when the cap is zero", async () => {
		const { loadRouterRules } = await import("./router-rules-store")
		const balance = defaultRules("balance")
		vi.mocked(loadRouterRules).mockImplementation(async (options?: { profile?: string }) =>
			options?.profile === "balance"
				? { ...balance, health: { ...balance.health, maxPaidCallsPerTurn: 0 } }
				: defaultRules(options?.profile),
		)
		try {
			const { rows, logged, run, classifierModel } = setup(PLINY_BALANCE_AUTO_MODEL_ID)
			classifierModel.mockReturnValue(scripted([{ type: "text-delta", text: '{"tier":"reason","think":true}' }, STOP]))
			await run({}, 3)
			expect(logged.every((record) => record.model === "aws-bedrock-vmodels/claude-4-6-sonnet-high-thinking")).toBe(true)
			expect(rows.some((row) => row.includes("paid calls this turn"))).toBe(false)
		} finally {
			vi.mocked(loadRouterRules).mockImplementation(async (options?: { profile?: string }) =>
				defaultRules(options?.profile),
			)
		}
	})

	it("routes on the user's request, not on a reminder or the editor state appended to it", async () => {
		const { rows, run, config } = setup(PLINY_FREE_AUTO_MODEL_ID)
		const factory = config.agentModelFactory
		if (!factory) {
			throw new Error("no factory")
		}
		const model = factory({
			config: { modelId: PLINY_FREE_AUTO_MODEL_ID } as never,
			createDefault: () => scripted([TEXT, STOP]),
		})
		const messages: AgentMessage[] = [
			{
				id: "u1",
				role: "user",
				content: [
					{
						type: "text",
						text: '<user_input mode="act">what is this repo?\n<editor_state>\nActive file: src/app.ts\nOpen tabs:\n- .github/skills/code-sanitization/SKILL.md\n</editor_state></user_input>',
					},
				],
				createdAt: 0,
			},
			{ id: "a1", role: "assistant", content: [{ type: "text", text: "Let me look:" }], createdAt: 1 },
			{
				id: "u2",
				role: "user",
				content: [
					{
						type: "text",
						text: "[SYSTEM] Your last message said what you would do next, but you did not call a tool.",
					},
				],
				createdAt: 2,
				metadata: { displayRole: "system", userRunSpan: 0 },
			},
		]
		for await (const _event of await model.stream({ messages, tools: [] })) {
			// drain
		}
		// Without the editor state the prompt is a short question: the quick route, not coding.
		expect(rows[0]).toContain("route: quick")
		void run
	})

	it("nudges an unfinished BalanceAuto reply only when a free model wrote it", async () => {
		const { rows, run, config, classifierModel } = setup(PLINY_BALANCE_AUTO_MODEL_ID)
		// Nothing has run yet: no model to blame, so no nudge.
		expect(await config.completionGuard?.(UNFINISHED_REPLY)).toBeUndefined()

		// A reasoning turn lands on paid Claude, which does not stop early: no nudge.
		classifierModel.mockReturnValueOnce(scripted([{ type: "text-delta", text: '{"tier":"reason","think":true}' }, STOP]))
		await run()
		expect(await config.completionGuard?.(UNFINISHED_REPLY)).toBeUndefined()

		// The guard only ever judges the root agent's reply (sub-agents get no
		// completion policy), so a free sub-agent run must not make a paid root
		// reply look like a free model's.
		await run({ parentAgentId: "parent" })
		expect(await config.completionGuard?.(UNFINISHED_REPLY)).toBeUndefined()

		// A root turn the classifier sends to a free model is nudged.
		classifierModel.mockReturnValueOnce(scripted([{ type: "text-delta", text: '{"tier":"quick","think":false}' }, STOP]))
		await run()
		expect(rows[rows.length - 1]).toContain("auto-paid-balanced → **kimi-k2.6**")
		expect(await config.completionGuard?.({ ...UNFINISHED_REPLY, iteration: 1 })).toContain("did not call a tool")
		expect(rows[rows.length - 1]).toContain("stopped after")
	})

	it("adds the failed-command note on BalanceAuto only for a tool a free model ran", async () => {
		const { run, config, classifierModel } = setup(PLINY_BALANCE_AUTO_MODEL_ID)
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

		// A reasoning turn lands on paid Claude: no note.
		classifierModel.mockReturnValueOnce(scripted([{ type: "text-delta", text: '{"tier":"reason","think":true}' }, STOP]))
		await run()
		expect(await failedShell()).toBeUndefined()

		await run({ parentAgentId: "parent" })
		// The sub-agent's tool ran under a free model: note added.
		expect((await failedShell("parent"))?.appendContext).toContain("exited with code 2")
		// The root agent is still on the paid model.
		expect(await failedShell()).toBeUndefined()
	})

	it("never classifies a sub-agent call, nor anything on the default profile", async () => {
		const smart = setup("pliny/auto-free-smart")
		await smart.run({ parentAgentId: "parent" })
		expect(smart.classifierModel).not.toHaveBeenCalled()

		const plain = setup()
		await plain.run()
		expect(plain.createdFor).not.toContain(CLASSIFIER)
	})
})

describe("installRouter run recovery", () => {
	beforeEach(() => {
		resetHealth()
		resetSessions()
	})

	const SOCKET_ERROR = "terminated: SocketError: other side closed (UND_ERR_SOCKET)"
	const recover = (config: CoreSessionConfig, error: string, attempt = 1, hadAssistantContent = true) => {
		if (!config.onRunError) {
			throw new Error("router did not install onRunError")
		}
		return config.onRunError({ error, errorClass: undefined, attempt, modelId: config.modelId, hadAssistantContent })
	}

	it("retries a dropped connection after a short wait, without counting it against the model", async () => {
		const { rows, run, config, sleeps } = setup()
		await run()
		const modelId = getSessionState("root").calls[0].modelId

		const decision = await recover(config, SOCKET_ERROR)
		expect(decision).toMatchObject({ retry: true })
		expect(sleeps).toEqual([2000])
		expect(rows.at(-1)).toContain("dropped")
		expect(rows.at(-1)).not.toContain("another model")

		// A second drop in the same turn is a failure like any other.
		await run()
		await recover(config, SOCKET_ERROR, 2)
		expect(rows.at(-1)).toContain("retrying with another model")
		expect(sleeps).toEqual([2000])
		// One failure recorded, below the bench threshold of two.
		expect(isModelHealthy(modelId, NOW)).toBe(true)
	})

	it("continues the turn on the recovery run: calls, failovers and the budget carry over", async () => {
		const { rows, run, config } = setup()
		await run()
		await recover(config, "Stream stalled: no output for 90s")
		await run()
		expect(getSessionState("root").calls).toHaveLength(2)
		expect(getSessionState("root").failovers).toBe(1)

		await recover(config, "Stream stalled: no output for 90s", 2)
		await run()
		await recover(config, "Stream stalled: no output for 90s", 3)
		await run()
		expect(getSessionState("root").failovers).toBe(3)
		expect(await recover(config, "Stream stalled: no output for 90s", 4)).toBe(false)
		expect(rows.at(-1)).toContain("stopped retrying after 3 failovers")

		// The next user turn starts afresh.
		await run()
		expect(getSessionState("root").calls).toHaveLength(1)
		expect(getSessionState("root").failovers).toBe(0)
	})

	it("asks for a lost tool call to be made again, not continued as text", async () => {
		const { run, config } = setup()
		await run()
		const decision = await recover(config, `${SOCKET_ERROR} — cut off while writing a read_files call`)
		const prompt = decision && decision.retry ? (decision.continuationPrompt ?? "") : ""
		expect(prompt).toContain("Your previous reply was cut off (terminated: SocketError: other side closed)")
		expect(prompt).toContain("`read_files` tool call")
		expect(prompt).toContain("not as text")
		expect(prompt).not.toContain("Continue exactly where it stopped")
	})

	it("names models by their catalog name in chat rows", async () => {
		const names = Object.fromEntries(defaultRules().pool.map((id) => [id, { name: `Model ${id.length}` }]))
		const { rows, run } = setup(PLINY_FREE_AUTO_MODEL_ID, names)
		await run()
		const modelId = getSessionState("root").calls[0].modelId
		expect(rows[0]).toContain(`→ **${names[modelId].name}**`)
	})
})

describe("installRouter tokens and cost in the logs", () => {
	beforeEach(() => {
		resetHealth()
		resetSessions()
	})

	const KIMI = "snps-provider/kimi-k2.6"
	const SONNET_THINKING = "aws-bedrock-vmodels/claude-4-6-sonnet-high-thinking"
	const usageEvent = (inputTokens: number, outputTokens: number, totalCost?: number): AgentModelEvent => ({
		type: "usage",
		usage: {
			inputTokens,
			outputTokens,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			...(totalCost !== undefined ? { totalCost } : {}),
		},
	})

	/** Installs the router with each model's reply scripted, and drives runs the way the engine does. */
	function install(modelId: string, script: (modelId: string) => AgentModelEvent[]) {
		const calls: RouterCallLogRecord[] = []
		const runs: RouterRunLogRecord[] = []
		const config = installRouter({ providerId: "pliny", modelId, cwd: "/tmp" } as unknown as CoreSessionConfig, {
			sessionId: "u",
			getMode: () => "act",
			emitRow: () => undefined,
			nextMessageTs: () => 1,
			logCall: (record) => calls.push(record),
			logRun: (record) => runs.push(record),
			now: () => NOW,
		})
		const factory = config.agentModelFactory
		if (!factory) {
			throw new Error("router did not install a model factory")
		}
		const start = (run: { agentId: string; runId: string; parentAgentId?: string }) => {
			const model = factory({
				config: { modelId, ...(run.parentAgentId ? { parentAgentId: run.parentAgentId } : {}) } as never,
				agentId: run.agentId,
				createDefault: (overrides) => scripted(script(overrides?.modelId ?? "(default)")),
			})
			const snapshot = (iteration: number) =>
				({
					agentId: run.agentId,
					runId: run.runId,
					iteration,
					...(run.parentAgentId ? { parentAgentId: run.parentAgentId } : {}),
				}) as never
			let iteration = 0
			return {
				call: async () => {
					iteration += 1
					await config.hooks?.beforeModel?.({ snapshot: snapshot(iteration), request: request() })
					for await (const _event of await model.stream(request())) {
						// drain
					}
				},
				end: async (status: "completed" | "failed" = "completed") => {
					await config.hooks?.afterRun?.({
						snapshot: snapshot(iteration),
						result: {
							agentId: run.agentId,
							runId: run.runId,
							status,
							iterations: iteration,
							outputText: "Done.",
							messages: [assistant("Done.")],
							usage: {} as never,
						},
					})
				},
			}
		}
		return { calls, runs, start }
	}

	it("logs a call's tokens, its cost and its place in the run", async () => {
		const { calls, start } = install(PLINY_FREE_AUTO_MODEL_ID, () => [TEXT, usageEvent(1200, 80), STOP])
		const run = start({ agentId: "agent-1", runId: "run-7" })
		await run.call()
		await run.call()
		expect(calls).toEqual([
			expect.objectContaining({
				model: KIMI,
				outcome: "success",
				usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
				// A free model costs nothing even when the gateway prices nothing.
				costUsd: 0,
				runId: "run-7",
				iteration: 1,
			}),
			expect.objectContaining({ runId: "run-7", iteration: 2, costUsd: 0 }),
		])
	})

	it("still logs what is known when a call fails after its output", async () => {
		const { calls, start } = install(PLINY_FREE_AUTO_MODEL_ID, () => [
			TEXT,
			usageEvent(900, 40),
			{ type: "finish", reason: "error", error: "terminated: SocketError: other side closed" },
		])
		const run = start({ agentId: "agent-1", runId: "run-8" })
		await run.call()
		expect(calls).toEqual([
			expect.objectContaining({
				model: KIMI,
				outcome: "error",
				error: "terminated: SocketError: other side closed",
				usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
				costUsd: 0,
				runId: "run-8",
				iteration: 1,
			}),
		])
	})

	it("logs a free model's call as costing nothing even when the gateway reports a cost", async () => {
		const { calls, start } = install(PLINY_FREE_AUTO_MODEL_ID, () => [TEXT, usageEvent(1200, 80, 0.005), STOP])
		const run = start({ agentId: "agent-1", runId: "run-9" })
		await run.call()
		expect(calls).toEqual([expect.objectContaining({ model: KIMI, outcome: "success", costUsd: 0, runId: "run-9" })])
	})

	it("writes the turn's totals, paid share and sub-agent spend into the run record", async () => {
		const { calls, runs, start } = install(PLINY_BALANCE_AUTO_MODEL_ID, (modelId) => {
			if (modelId === CLASSIFIER) {
				return [{ type: "text-delta", text: '{"tier":"reason","think":true}' }, STOP]
			}
			return modelId === SONNET_THINKING
				? [TEXT, usageEvent(20_000, 1_000, 0.03), STOP]
				: [TEXT, usageEvent(5_000, 200), STOP]
		})
		const root = start({ agentId: "root-agent", runId: "run-1" })
		await root.call()
		// A sub-agent runs inside the turn, on a free model.
		const sub = start({ agentId: "sub-agent", runId: "run-2", parentAgentId: "root-agent" })
		await sub.call()
		await sub.end()
		await root.call()
		await root.end()

		expect(calls.map((record) => [record.model, record.subAgent, record.costUsd, record.runId])).toEqual([
			[SONNET_THINKING, false, 0.03, "run-1"],
			[KIMI, true, 0, "run-2"],
			[SONNET_THINKING, false, 0.03, "run-1"],
		])
		expect(runs).toHaveLength(2)
		expect(runs[0]).toMatchObject({ subAgent: true, runId: "run-2", calls: 1, costUsd: 0, paidCalls: 0 })
		expect(runs[0]?.subAgentCalls).toBeUndefined()
		expect(runs[1]).toMatchObject({
			subAgent: false,
			profile: "balance",
			runId: "run-1",
			calls: 2,
			ending: "text",
			usage: { inputTokens: 40_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
			models: { [SONNET_THINKING]: 2 },
			paidCalls: 2,
			failovers: 0,
			subAgentCalls: 1,
			subAgentUsage: { inputTokens: 5_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
			subAgentCostUsd: 0,
		})
		expect(runs[1]?.costUsd).toBeCloseTo(0.06)
		expect(runs[1]?.paidCostUsd).toBeCloseTo(0.06)

		// The next turn starts its totals afresh.
		const next = start({ agentId: "root-agent", runId: "run-3" })
		await next.call()
		await next.end()
		expect(runs[2]).toMatchObject({ runId: "run-3", calls: 1, paidCalls: 1 })
		expect(runs[2]?.subAgentCalls).toBeUndefined()
	})

	it("leaves a paid call's cost out when it reported no usage", async () => {
		const { calls, runs, start } = install(PLINY_BALANCE_AUTO_MODEL_ID, (modelId) =>
			modelId === CLASSIFIER ? [{ type: "text-delta", text: '{"tier":"reason","think":true}' }, STOP] : [TEXT, STOP],
		)
		const run = start({ agentId: "root-agent", runId: "run-1" })
		await run.call()
		await run.end()
		expect(calls[0]?.model).toBe(SONNET_THINKING)
		expect(calls[0]?.usage).toBeUndefined()
		expect(calls[0]?.costUsd).toBeUndefined()
		expect(runs[0]).toMatchObject({ paidCalls: 1, models: { [SONNET_THINKING]: 1 } })
		expect(runs[0]?.costUsd).toBeUndefined()
		expect(runs[0]?.usage).toBeUndefined()
	})
})

describe("installRouter images", () => {
	beforeEach(() => {
		resetHealth()
		resetSessions()
	})

	const HAIKU = "snps-aws-bedrock/global-anthropic-claude-haiku-4-5-20251001-v1-0"
	const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

	function imageSetup(images: RouterInstallDeps["images"], sessionId: string) {
		const rows: Array<{ say?: string; text?: string }> = []
		let ts = 0
		const knownModels = {
			[HAIKU]: {
				id: HAIKU,
				name: "Claude Haiku 4.5",
				capabilities: ["streaming", "tools", "images"],
				pricing: { input: 1, output: 5 },
			},
		}
		const config = installRouter(
			{ providerId: "pliny", modelId: PLINY_FREE_AUTO_MODEL_ID, cwd: "/tmp", knownModels } as unknown as CoreSessionConfig,
			{
				sessionId,
				getMode: () => "act",
				emitRow: (message) => rows.push({ say: message.say, text: message.text }),
				nextMessageTs: () => ++ts,
				logCall: () => undefined,
				now: () => NOW,
				...(images ? { images } : {}),
			},
		)
		const sent: Array<{ modelId: string; request: AgentModelRequest }> = []
		const run = async () => {
			const model = config.agentModelFactory?.({
				config: { modelId: PLINY_FREE_AUTO_MODEL_ID, knownModels } as never,
				createDefault: (overrides) => {
					const modelId = overrides?.modelId ?? "(default)"
					if (modelId === HAIKU) {
						return scripted([
							{ type: "text-delta", text: "A terminal showing: npm ERR! missing script: build" },
							{ type: "usage", usage: { inputTokens: 1700, outputTokens: 90, totalCost: 0.0021 } },
							STOP,
						])
					}
					return {
						async *stream(request: AgentModelRequest) {
							sent.push({ modelId, request })
							yield TEXT
							yield STOP
						},
					}
				},
			})
			if (!model) {
				throw new Error("router did not install a model factory")
			}
			const message: AgentMessage = {
				id: "u",
				role: "user",
				content: [
					{ type: "text", text: "why does the build fail?" },
					{ type: "image", image: PNG, mediaType: "image/png" },
				],
				createdAt: 0,
			}
			for await (const _event of await model.stream({ messages: [message], tools: [] })) {
				// drain
			}
		}
		return { rows, run, sent }
	}

	it("describes the image, records its cost as a vision usage row and says so once", async () => {
		const usages: Array<{ sessionId: string; cost: number }> = []
		const { rows, run, sent } = imageSetup(
			{
				paidModelsUnlocked: () => true,
				checkBudget: async () => undefined,
				onUsage: (sessionId, usage) => usages.push({ sessionId, cost: usage.totalCost }),
			},
			"images-described",
		)
		await run()
		await run()

		const usageRows = rows.filter((row) => row.say === "subagent_usage")
		expect(usageRows).toHaveLength(1)
		expect(JSON.parse(usageRows[0].text ?? "{}")).toEqual({
			source: "vision",
			tokensIn: 1700,
			tokensOut: 90,
			cacheWrites: 0,
			cacheReads: 0,
			cost: 0.0021,
		})
		expect(usages).toEqual([{ sessionId: "images-described", cost: 0.0021 }])
		const notices = rows.filter((row) => row.text?.includes("Images were described by"))
		expect(notices).toHaveLength(1)
		expect(notices[0].text).toContain("**Claude Haiku 4.5**")
		// Every free call got the description instead of the image.
		expect(sent).toHaveLength(2)
		for (const { request } of sent) {
			const parts = request.messages[0].content
			expect(parts.some((part) => part.type === "image")).toBe(false)
			expect(parts.some((part) => part.type === "text" && part.text.includes("npm ERR! missing script: build"))).toBe(true)
		}
	})

	it("with paid models locked, drops the image with a note instead of failing the turn", async () => {
		const { rows, run, sent } = imageSetup(undefined, "images-locked")
		await run()
		expect(rows.some((row) => row.say === "subagent_usage")).toBe(false)
		expect(rows.some((row) => row.text?.includes("Unlock Pliny paid models"))).toBe(true)
		expect(sent).toHaveLength(1)
		const parts = sent[0].request.messages[0].content
		expect(parts.some((part) => part.type === "text" && part.text.includes("is not shown to you"))).toBe(true)
	})
})
