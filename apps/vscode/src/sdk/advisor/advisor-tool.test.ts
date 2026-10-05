import { type ModelInfo, plinyFreePoolIds, plinyThinkingControls } from "@plinycode/llms"
import type { AgentMessage, AgentModel, AgentModelEvent, AgentModelRequest, AgentToolContext } from "@plinycode/shared"
import { describe, expect, it, vi } from "vitest"
import { PLINY_BALANCE_AUTO_MODEL_ID, PLINY_FREE_AUTO_MODEL_ID } from "@/shared/pliny"
import { type AdvisorSettings, DEFAULT_ADVISOR_SETTINGS } from "./advisor-settings"
import { type AdvisorToolOutput, type AdvisorUsage, createAdvisorTool } from "./advisor-tool"

type AdvisorToolDeps = Parameters<typeof createAdvisorTool>[0]

const SONNET_5 = DEFAULT_ADVISOR_SETTINGS.model
const SONNET_INFO = {
	id: SONNET_5,
	pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
} as ModelInfo

function userMessage(text: string): AgentMessage {
	return { id: "u", role: "user", content: [{ type: "text", text }], createdAt: 0 }
}

function advisorResult(output: unknown, isError?: boolean): AgentMessage {
	return {
		id: "t",
		role: "tool",
		content: [{ type: "tool-result", toolCallId: "c", toolName: "ask_advisor", output, ...(isError ? { isError } : {}) }],
		createdAt: 0,
	}
}

function context(messages: AgentMessage[] = [], overrides: Partial<AgentToolContext> = {}): AgentToolContext {
	return {
		sessionId: "task-1",
		agentId: "root",
		iteration: 1,
		snapshot: {
			agentId: "root",
			status: "running",
			iteration: 1,
			messages,
			pendingToolCalls: [],
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		},
		...overrides,
	}
}

/** A model that streams the given events and records what it was sent. */
function scripted(events: AgentModelEvent[]) {
	const requests: AgentModelRequest[] = []
	const model: AgentModel = {
		async *stream(request) {
			requests.push(request)
			yield* events
		},
	}
	return { model, requests }
}

const ANSWER: AgentModelEvent[] = [
	{ type: "text-delta", text: "Use a mutex. " },
	{ type: "text-delta", text: "Then rerun the test." },
	{ type: "usage", usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.006 } },
	{ type: "finish", reason: "stop" },
]

function setup(
	options: { events?: AgentModelEvent[]; settings?: Partial<AdvisorSettings>; deps?: Partial<AdvisorToolDeps> } = {},
) {
	const { model, requests } = scripted(options.events ?? ANSWER)
	const createModel = vi.fn((_modelId: string): AgentModel | undefined => model)
	const checkBudget = vi.fn(async (_sessionId: string): Promise<string | undefined> => undefined)
	const onUsage = vi.fn((_sessionId: string, _usage: AdvisorUsage) => undefined)
	const tool = createAdvisorTool({
		getSettings: () => ({ ...DEFAULT_ADVISOR_SETTINGS, ...options.settings }),
		conversationModelId: () => PLINY_BALANCE_AUTO_MODEL_ID,
		createModel,
		modelInfo: (modelId) => (modelId === SONNET_5 ? SONNET_INFO : undefined),
		checkBudget,
		onUsage,
		ledger: { callsBySession: new Map(), inFlight: new Set() },
		...options.deps,
	})
	const ask = (input: unknown = { question: "Mutex or channel?" }, toolContext: AgentToolContext = context()) =>
		tool.execute(input, toolContext) as Promise<AdvisorToolOutput>
	return { tool, ask, requests, createModel, checkBudget, onUsage }
}

describe("the request sent to the advisor", () => {
	const promptOf = (request: AgentModelRequest) => (request.messages[0].content[0] as { text: string }).text

	it("sends the user's request, the question and the context, with no tools and a capped output", async () => {
		const { ask, requests } = setup()
		const messages = [userMessage('<user_input mode="act">fix the flaky cache test</user_input>')]
		await ask({ question: "Mutex or channel?", context: "TestCache fails 1 in 20 runs" }, context(messages))
		const prompt = promptOf(requests[0])
		expect(prompt).toContain("The user's request to the agent:\nfix the flaky cache test")
		expect(prompt).toContain("The agent's question:\nMutex or channel?")
		expect(prompt).toContain("Context the agent provided:\nTestCache fails 1 in 20 runs")
		expect(requests[0].tools).toEqual([])
		expect(requests[0].options).toEqual({ maxTokens: 1500 })
		expect(requests[0].systemPrompt).toContain("You have no tools")
	})

	it("attaches the latest real user request, not a tool result or an injected reminder", async () => {
		const { ask, requests } = setup()
		const messages: AgentMessage[] = [
			userMessage('<user_input mode="act">first request</user_input>'),
			userMessage('<user_input mode="act">make the cache test pass</user_input>'),
			advisorResult("…"),
			{ ...userMessage("[SYSTEM] keep going"), metadata: { displayRole: "system" } },
		]
		await ask(undefined, context(messages))
		expect(promptOf(requests[0])).toContain("The user's request to the agent:\nmake the cache test pass\n")
	})

	it("leaves the context section out when there is none, and clips an oversized one", async () => {
		const { ask, requests } = setup()
		await ask({ question: "q" })
		expect(promptOf(requests[0])).not.toContain("Context the agent provided")
		expect(promptOf(requests[0])).toContain("(not available)")

		await ask({ question: "q", context: "x".repeat(30_000) })
		expect(promptOf(requests[1]).length).toBeLessThan(25_000)
		expect(promptOf(requests[1])).toContain("cut at 24000 characters")
	})

	it("turns reasoning off only for a model with a measured reasoning switch", async () => {
		const measured = plinyFreePoolIds().find((id) => plinyThinkingControls(id))
		expect(measured).toBeDefined()
		const { ask, requests } = setup({ settings: { model: measured as string } })
		await ask()
		expect(requests[0].options).toMatchObject({ thinking: false })
	})
})

describe("ask_advisor", () => {
	it("describes when to use it and what the advisor can see", () => {
		const { tool } = setup()
		expect(tool.name).toBe("ask_advisor")
		expect(tool.description).toContain("has no tools")
		expect(tool.description).toContain("user's original request")
		expect(tool.description).toContain("two failed attempts")
		expect(tool.description).toContain("Do not use it for routine steps")
		expect(tool.inputSchema).toMatchObject({ required: ["question"] })
	})

	it("asks the advisor model and returns its advice with the call's usage and cost", async () => {
		const { ask, requests, createModel, checkBudget, onUsage } = setup()
		const messages = [userMessage('<user_input mode="act">fix the flaky cache test</user_input>')]
		const result = await ask({ question: "Mutex or channel?", context: "TestCache fails 1 in 20 runs" }, context(messages))

		expect(createModel).toHaveBeenCalledWith(SONNET_5)
		expect(checkBudget).toHaveBeenCalledWith("task-1")
		const prompt = (requests[0].messages[0].content[0] as { text: string }).text
		expect(prompt).toContain("fix the flaky cache test")
		expect(prompt).toContain("Mutex or channel?")
		expect(prompt).toContain("TestCache fails 1 in 20 runs")
		expect(requests[0].signal).toBeInstanceOf(AbortSignal)

		const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.006 }
		expect(result).toEqual({ advice: "Use a mutex. Then rerun the test.", model: SONNET_5, usage })
		expect(onUsage).toHaveBeenCalledWith("task-1", usage)
	})

	it("prices the call from the catalog when the provider reports tokens without a cost", async () => {
		const { ask } = setup({
			events: [
				{ type: "text-delta", text: "advice" },
				{ type: "usage", usage: { inputTokens: 2000, outputTokens: 1000 } },
				{ type: "finish", reason: "stop" },
			],
		})
		const result = await ask()
		// 2000 in at $3/M + 1000 out at $15/M.
		expect(result.usage.totalCost).toBeCloseTo(0.021, 6)
		expect(result.usage.estimated).toBeUndefined()
	})

	it("estimates the cost when the provider reports no usage at all", async () => {
		const { ask, onUsage } = setup({
			events: [
				{ type: "text-delta", text: "a".repeat(400) },
				{ type: "finish", reason: "stop" },
			],
		})
		const result = await ask()
		expect(result.usage.estimated).toBe(true)
		expect(result.usage.outputTokens).toBe(100)
		expect(result.usage.inputTokens).toBeGreaterThan(0)
		expect(result.usage.totalCost).toBeGreaterThan(0)
		expect(onUsage).toHaveBeenCalledTimes(1)
	})

	it("says so when the advice was cut off at the output cap", async () => {
		const { ask } = setup({
			events: [
				{ type: "text-delta", text: "First, " },
				{ type: "usage", usage: { inputTokens: 10, outputTokens: 1500, totalCost: 0.02 } },
				{ type: "finish", reason: "max-tokens" },
			],
		})
		expect((await ask()).advice).toBe("First,\n\n[The advice was cut off at its length limit.]")
	})

	it("refuses once the conversation has used its calls, without calling the model", async () => {
		const { ask, requests } = setup({ settings: { maxCallsPerConversation: 2 } })
		await ask()
		await ask()
		await expect(ask()).rejects.toThrow("asked 2 times in this conversation, which is the limit (2)")
		expect(requests).toHaveLength(2)
		// Another conversation has its own count.
		await expect(ask(undefined, context([], { sessionId: "task-2" }))).resolves.toMatchObject({ advice: expect.any(String) })
	})

	it("counts the advisor answers already in the conversation, so the limit survives a restart", async () => {
		const { ask, requests } = setup({ settings: { maxCallsPerConversation: 2 } })
		const history = [
			advisorResult({ advice: "a" }),
			// A refused call was never sent and does not count.
			advisorResult({ error: "refused" }, true),
			advisorResult({ advice: "b" }),
		]
		await expect(ask(undefined, context(history))).rejects.toThrow("which is the limit (2)")
		expect(requests).toHaveLength(0)
	})

	it("is blocked by the conversation budget: no call, and the slot is not used", async () => {
		const { ask, requests, checkBudget, onUsage } = setup({ settings: { maxCallsPerConversation: 1 } })
		checkBudget.mockResolvedValueOnce("This conversation has spent $5.02, reaching its $5.00 budget.")
		await expect(ask()).rejects.toThrow(
			"This conversation has spent $5.02, reaching its $5.00 budget. The advisor was not asked. Decide on your own.",
		)
		expect(requests).toHaveLength(0)
		expect(onUsage).not.toHaveBeenCalled()
		// The budget was raised: the one allowed call is still available.
		await expect(ask()).resolves.toMatchObject({ advice: expect.any(String) })
	})

	it("refuses when the setting or the conversation's model does not offer it", async () => {
		const off = setup({ settings: { use: "never" } })
		await expect(off.ask()).rejects.toThrow("The advisor is turned off")
		const freeAuto = setup({ deps: { conversationModelId: () => PLINY_FREE_AUTO_MODEL_ID } })
		await expect(freeAuto.ask()).rejects.toThrow("only available in conversations that run on auto-paid-balanced")
		expect(off.requests).toHaveLength(0)
		expect(freeAuto.requests).toHaveLength(0)

		const always = setup({ settings: { use: "always" }, deps: { conversationModelId: () => PLINY_FREE_AUTO_MODEL_ID } })
		await expect(always.ask()).resolves.toMatchObject({ advice: expect.any(String) })
	})

	it("refuses a call from the advisor model itself", async () => {
		const { ask, requests } = setup({ deps: { callingModelId: () => SONNET_5 } })
		await expect(ask()).rejects.toThrow("already running on the advisor model")
		expect(requests).toHaveLength(0)
	})

	it("refuses a sub-agent", async () => {
		const { ask, requests } = setup()
		const subAgent = context()
		await expect(ask(undefined, { ...subAgent, snapshot: { ...subAgent.snapshot!, parentAgentId: "root" } })).rejects.toThrow(
			"not available to sub-agents",
		)
		expect(requests).toHaveLength(0)
	})

	it("refuses an advisor model whose price is unknown, since its cost could not be shown", async () => {
		const { ask, requests } = setup({ settings: { model: "azure-openai/some-new-model" } })
		await expect(ask()).rejects.toThrow("has no known price")
		expect(requests).toHaveLength(0)
	})

	it("needs a question", async () => {
		const { ask, requests } = setup()
		await expect(ask({ context: "only context" })).rejects.toThrow("needs a `question`")
		expect(requests).toHaveLength(0)
	})

	it("returns an error result when the call fails before any output, at no cost", async () => {
		const { ask, onUsage } = setup({ events: [{ type: "finish", reason: "error", error: "503 from the gateway" }] })
		await expect(ask()).rejects.toThrow("The advisor could not answer: 503 from the gateway. Decide on your own.")
		expect(onUsage).not.toHaveBeenCalled()
	})

	it("returns an error result when the model throws or has not been built yet", async () => {
		const throwing = setup({
			deps: {
				createModel: () => ({
					stream() {
						throw new Error("socket hang up")
					},
				}),
			},
		})
		await expect(throwing.ask()).rejects.toThrow("The advisor could not answer: socket hang up")
		const notReady = setup({ deps: { createModel: () => undefined } })
		await expect(notReady.ask()).rejects.toThrow("The advisor is not ready yet")
	})

	it("reports an empty answer as a failure and still records what it cost", async () => {
		const { ask, onUsage } = setup({
			events: [
				{ type: "usage", usage: { inputTokens: 900, outputTokens: 5, totalCost: 0.003 } },
				{ type: "finish", reason: "stop" },
			],
		})
		const result = await ask()
		expect(result.advice).toBeUndefined()
		expect(result.error).toContain("returned an empty answer")
		expect(result.usage.totalCost).toBe(0.003)
		expect(onUsage).toHaveBeenCalledTimes(1)
	})

	it("times out, aborts the request, and records an estimated cost for the call it paid for", async () => {
		let signal: AbortSignal | undefined
		const hanging: AgentModel = {
			async *stream(request) {
				signal = request.signal
				yield { type: "text-delta", text: "Let me think" } satisfies AgentModelEvent
				await new Promise(() => undefined)
			},
		}
		const { ask, onUsage } = setup({ deps: { createModel: () => hanging, timeoutMs: 20 } })
		const result = await ask()
		expect(result.advice).toBeUndefined()
		expect(result.error).toContain("timed out")
		expect(result.usage.estimated).toBe(true)
		expect(result.usage.totalCost).toBeGreaterThan(0)
		expect(signal?.aborted).toBe(true)
		expect(onUsage).toHaveBeenCalledTimes(1)
	})

	it("counts a timed-out call against the limit", async () => {
		const hanging: AgentModel = {
			async *stream() {
				await new Promise(() => undefined)
			},
		}
		const { ask } = setup({ settings: { maxCallsPerConversation: 1 }, deps: { createModel: () => hanging, timeoutMs: 10 } })
		await expect(ask()).resolves.toMatchObject({ error: expect.stringContaining("timed out") })
		await expect(ask()).rejects.toThrow("which is the limit (1)")
	})

	it("stops when the run is cancelled", async () => {
		const run = new AbortController()
		const hanging: AgentModel = {
			async *stream(request) {
				await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve()))
				yield { type: "finish", reason: "aborted" } satisfies AgentModelEvent
			},
		}
		const { ask } = setup({ deps: { createModel: () => hanging } })
		const pending = ask(undefined, context([], { signal: run.signal }))
		run.abort()
		await expect(pending).rejects.toThrow("The advisor could not answer: cancelled")
	})

	it("answers one question at a time", async () => {
		const waiting: Array<() => void> = []
		const slow: AgentModel = {
			async *stream() {
				await new Promise<void>((resolve) => waiting.push(resolve))
				yield* ANSWER
			},
		}
		const { tool, ask } = setup({ deps: { createModel: () => slow } })
		expect(tool.executionMode).toBe("sequential")
		const first = ask()
		await vi.waitFor(() => expect(waiting).toHaveLength(1))
		await expect(ask()).rejects.toThrow("already answering a question")
		waiting[0]()
		await expect(first).resolves.toMatchObject({ advice: expect.any(String) })
		// Free again once the first call has finished.
		const third = ask()
		await vi.waitFor(() => expect(waiting).toHaveLength(2))
		waiting[1]()
		await expect(third).resolves.toMatchObject({ advice: expect.any(String) })
	})
})
