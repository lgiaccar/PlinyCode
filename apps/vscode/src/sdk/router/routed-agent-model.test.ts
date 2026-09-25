import type { AgentModel, AgentModelEvent, AgentModelRequest } from "@plinycode/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createRoutedAgentModel, type RoutedAgentModelDeps, type RouterObserver } from "./routed-agent-model"
import { defaultRules } from "./router-rules"
import type { RouterRequestFeatures, RouterRules } from "./router-types"

const POOL = ["snps-provider/first", "snps-provider/second", "snps-provider/third"]

function rules(overrides: Partial<RouterRules> = {}): RouterRules {
	const base = defaultRules()
	return {
		...base,
		pool: POOL,
		routes: [{ name: "test", use: POOL }],
		...overrides,
	}
}

function features(): RouterRequestFeatures {
	return {
		estimatedTokens: 100,
		mode: "act",
		prompt: "do the thing",
		hasImages: false,
		isSubAgent: false,
		callIndex: 1,
	}
}

function request(): AgentModelRequest {
	return { messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] } as never
}

/** A delegate that yields a fixed script of events. */
function scripted(events: AgentModelEvent[]): AgentModel {
	return {
		// eslint-disable-next-line require-yield
		async *stream() {
			for (const event of events) {
				yield event
			}
		},
	}
}

/** A delegate whose stream throws, optionally after emitting some events. */
function throwing(error: Error, before: AgentModelEvent[] = []): AgentModel {
	return {
		async *stream() {
			for (const event of before) {
				yield event
			}
			throw error
		},
	}
}

function recordingObserver() {
	const events: Array<{ kind: string; modelId: string; extra?: unknown }> = []
	const observer: RouterObserver = {
		onCallStart: ({ modelId }) => events.push({ kind: "start", modelId }),
		onFailover: ({ modelId, nextModelId, error }) =>
			events.push({ kind: "failover", modelId, extra: { nextModelId, error } }),
		onCallSuccess: ({ modelId }) => events.push({ kind: "success", modelId }),
		onCallError: ({ modelId, error }) => events.push({ kind: "error", modelId, extra: error }),
	}
	return { observer, events }
}

function build(options: {
	delegates: Record<string, AgentModel>
	configured?: RouterRules
	observer?: RouterObserver
	isHealthy?: (modelId: string) => boolean
	classify?: RoutedAgentModelDeps["classify"]
}) {
	const { observer, events } = recordingObserver()
	const model = createRoutedAgentModel({
		rules: () => options.configured ?? rules(),
		features,
		knownModels: () => undefined,
		isHealthy: options.isHealthy ?? (() => true),
		createDelegate: (modelId) => options.delegates[modelId] ?? scripted([{ type: "finish", reason: "stop" }]),
		observer: options.observer ?? observer,
		...(options.classify ? { classify: options.classify } : {}),
		now: () => 1_700_000_000_000,
	})
	return { model, events }
}

async function collect(model: AgentModel, req: AgentModelRequest = request()): Promise<AgentModelEvent[]> {
	const out: AgentModelEvent[] = []
	for await (const event of await model.stream(req)) {
		out.push(event)
	}
	return out
}

const TEXT: AgentModelEvent = { type: "text-delta", text: "hello" }
const STOP: AgentModelEvent = { type: "finish", reason: "stop" }

describe("createRoutedAgentModel", () => {
	beforeEach(() => {
		vi.useRealTimers()
	})

	it("uses the first candidate and forwards its events unchanged", async () => {
		const { model, events } = build({
			delegates: { "snps-provider/first": scripted([TEXT, STOP]) },
		})
		expect(await collect(model)).toEqual([TEXT, STOP])
		expect(events).toEqual([
			{ kind: "start", modelId: "snps-provider/first" },
			{ kind: "success", modelId: "snps-provider/first" },
		])
	})

	it("appends the router addendum to the system prompt for a free candidate only", async () => {
		const seen: Array<string | undefined> = []
		const capturing: AgentModel = {
			async *stream(req) {
				seen.push(req.systemPrompt)
				yield TEXT
				yield STOP
			},
		}
		const { model } = build({
			delegates: { "snps-provider/first": capturing, "snps-aws-bedrock/paid": capturing },
			configured: rules({
				pool: ["snps-provider/first", "snps-aws-bedrock/paid"],
				routes: [{ name: "test", use: ["snps-provider/first"] }],
			}),
		})
		await collect(model, { ...request(), systemPrompt: "You are Cline." })
		expect(seen[0]).toContain("You are Cline.")
		expect(seen[0]).toContain("# How your turn ends")

		const paid = build({
			delegates: { "snps-aws-bedrock/paid": capturing },
			configured: rules({ pool: ["snps-aws-bedrock/paid"], routes: [{ name: "test", use: ["snps-aws-bedrock/paid"] }] }),
		})
		await collect(paid.model, { ...request(), systemPrompt: "You are Cline." })
		expect(seen[1]).toBe("You are Cline.")
	})

	it("ends a call whose text degenerates into repetition as an error, so the run retries", async () => {
		const dots = Array.from(
			{ length: 40 },
			() =>
				({
					type: "text-delta",
					text: " .   .   .   .   .   .   .   .   .   .   .   .   .   .   .   .   .   .   .   .",
				}) as AgentModelEvent,
		)
		const { model, events } = build({
			delegates: {
				"snps-provider/first": scripted([{ type: "text-delta", text: "Good, we're on stage. ]]]]}]" }, ...dots, STOP]),
			},
		})
		const out = await collect(model)
		const finish = out.at(-1)
		expect(finish).toMatchObject({ type: "finish", reason: "error", errorRetryable: true })
		expect((finish as { error?: string }).error).toContain("Degenerate output")
		// The dots already streamed stay in the transcript; the loop's run-level retry handles them.
		expect(out.filter((event) => event.type === "text-delta").length).toBeGreaterThan(1)
		expect(out.filter((event) => event.type === "text-delta").length).toBeLessThan(dots.length + 1)
		expect(events.at(-1)).toMatchObject({ kind: "error", modelId: "snps-provider/first" })
	})

	it("fails over silently when a candidate errors before producing output", async () => {
		const { model, events } = build({
			delegates: {
				"snps-provider/first": scripted([{ type: "finish", reason: "error", error: "boom" }]),
				"snps-provider/second": scripted([TEXT, STOP]),
			},
		})
		// The consumer sees only the successful attempt.
		expect(await collect(model)).toEqual([TEXT, STOP])
		expect(events.map((e) => e.kind)).toEqual(["start", "failover", "start", "success"])
		expect(events[1].modelId).toBe("snps-provider/first")
		expect(events[2].modelId).toBe("snps-provider/second")
	})

	it("fails over when a candidate's stream throws before producing output", async () => {
		const { model } = build({
			delegates: {
				"snps-provider/first": throwing(new Error("terminated: SocketError: other side closed")),
				"snps-provider/second": scripted([TEXT, STOP]),
			},
		})
		expect(await collect(model)).toEqual([TEXT, STOP])
	})

	it("treats an empty but clean turn as a failure worth retrying elsewhere", async () => {
		const { model, events } = build({
			delegates: {
				"snps-provider/first": scripted([STOP]),
				"snps-provider/second": scripted([TEXT, STOP]),
			},
		})
		expect(await collect(model)).toEqual([TEXT, STOP])
		expect(events[1].kind).toBe("failover")
	})

	it("does not rethrow after content: it converts the throw into a finish", async () => {
		const { model, events } = build({
			delegates: {
				"snps-provider/first": throwing(new Error("terminated"), [TEXT]),
				"snps-provider/second": scripted([TEXT, STOP]),
			},
		})
		const out = await collect(model)
		expect(out[0]).toEqual(TEXT)
		expect(out[1]).toMatchObject({ type: "finish", reason: "error" })
		// The already-streamed text must not be duplicated by a second attempt.
		expect(out.filter((e) => e.type === "text-delta")).toHaveLength(1)
		expect(events.some((e) => e.kind === "error")).toBe(true)
	})

	it("forwards a failing finish that arrives after content, without switching models", async () => {
		const { model } = build({
			delegates: {
				"snps-provider/first": scripted([TEXT, { type: "finish", reason: "error", error: "cut off" }]),
				"snps-provider/second": scripted([TEXT, STOP]),
			},
		})
		const out = await collect(model)
		expect(out).toEqual([TEXT, { type: "finish", reason: "error", error: "cut off" }])
	})

	it("names a stream that ended without a finish reason", async () => {
		const { model } = build({
			delegates: { "snps-provider/first": scripted([TEXT]) },
		})
		const out = await collect(model)
		expect(out[0]).toEqual(TEXT)
		expect(out[1]).toMatchObject({ type: "finish", reason: "error" })
		expect((out[1] as { error?: string }).error).toContain("without a finish reason")
	})

	it("fails over when a stream ends with no finish and no content", async () => {
		const { model, events } = build({
			delegates: {
				"snps-provider/first": scripted([]),
				"snps-provider/second": scripted([TEXT, STOP]),
			},
		})
		expect(await collect(model)).toEqual([TEXT, STOP])
		expect(events[1].kind).toBe("failover")
	})

	it("does not fail over on an auth error", async () => {
		const authError = Object.assign(new Error("Unauthorized"), { statusCode: 401 })
		const { model, events } = build({
			delegates: {
				"snps-provider/first": throwing(authError),
				"snps-provider/second": scripted([TEXT, STOP]),
			},
		})
		const out = await collect(model)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ type: "finish", reason: "error", errorRetryable: false })
		expect(events.some((e) => e.kind === "failover")).toBe(false)
	})

	it("reports an abort as an abort and stops", async () => {
		const controller = new AbortController()
		controller.abort()
		const aborted = Object.assign(new Error("Aborted"), { name: "AbortError" })
		const { model, events } = build({
			delegates: { "snps-provider/first": throwing(aborted) },
		})
		const req = { ...request(), signal: controller.signal }
		const out = await collect(model, req)
		expect(out).toEqual([{ type: "finish", reason: "aborted" }])
		expect(events.some((e) => e.kind === "failover")).toBe(false)
	})

	it("gives up with a non-retryable error once every candidate has failed", async () => {
		const failing = scripted([{ type: "finish", reason: "error", error: "nope" }])
		const { model } = build({
			delegates: {
				"snps-provider/first": failing,
				"snps-provider/second": failing,
				"snps-provider/third": failing,
			},
		})
		const out = await collect(model)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ type: "finish", reason: "error", errorRetryable: false })
		expect((out[0] as { error?: string }).error).toContain("nope")
	})

	it("refuses a request with images instead of sending it to a text-only model", async () => {
		const createDelegate = vi.fn(() => scripted([TEXT, STOP]))
		const { observer, events } = recordingObserver()
		const model = createRoutedAgentModel({
			rules: () => rules(),
			features: () => ({ ...features(), hasImages: true }),
			knownModels: () => undefined,
			isHealthy: () => true,
			createDelegate,
			observer,
		})
		const out = await collect(model)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({ type: "finish", reason: "error", errorRetryable: false })
		expect((out[0] as { error?: string }).error).toContain("images")
		expect(createDelegate).not.toHaveBeenCalled()
		expect(events).toEqual([])
	})

	it("switches reasoning per candidate from the route's effort and the model's measured switch", async () => {
		const seen: Array<{ modelId: string; options: unknown }> = []
		const recordingDelegate = (modelId: string, events: AgentModelEvent[]): AgentModel => ({
			async *stream(req) {
				seen.push({ modelId, options: req.options })
				yield* events
			},
		})
		const { observer, events } = recordingObserver()
		const starts: Array<{ modelId: string; effort?: string }> = []
		const model = createRoutedAgentModel({
			rules: () => rules({ routes: [{ name: "fast", use: POOL, effort: "quick" }] }),
			features,
			knownModels: () => undefined,
			isHealthy: () => true,
			thinkingControls: (modelId) =>
				modelId === "snps-provider/first" ? { defaultOn: true, off: "template-kwargs" } : undefined,
			createDelegate: (modelId) =>
				modelId === "snps-provider/first"
					? recordingDelegate(modelId, [{ type: "finish", reason: "error", error: "boom" }])
					: recordingDelegate(modelId, [TEXT, STOP]),
			observer: {
				...observer,
				onCallStart: (info) => {
					starts.push({ modelId: info.modelId, effort: info.effort })
					observer.onCallStart(info)
				},
			},
		})
		await collect(model, { ...request(), options: { thinking: true, reasoningEffort: "high" } })

		// The measured model gets reasoning switched off; the unmeasured backup keeps the caller's options.
		expect(seen[0]).toEqual({
			modelId: "snps-provider/first",
			options: { thinking: false, reasoningEffort: undefined },
		})
		expect(seen[1]).toEqual({ modelId: "snps-provider/second", options: { thinking: true, reasoningEffort: "high" } })
		expect(starts).toEqual([
			{ modelId: "snps-provider/first", effort: "quick" },
			{ modelId: "snps-provider/second", effort: undefined },
		])
		expect(events.map((e) => e.kind)).toEqual(["start", "failover", "start", "success"])
	})

	it("routes with the classifier's verdict", async () => {
		const classify = vi.fn(async () => ({ tier: "code" as const, think: false }))
		const { model, events } = build({
			delegates: { "snps-provider/third": scripted([TEXT, STOP]) },
			configured: rules({
				routes: [
					{ name: "coding", tier: "code", use: ["snps-provider/third"] },
					{ name: "test", use: POOL },
				],
			}),
			classify,
		})
		expect(await collect(model)).toEqual([TEXT, STOP])
		expect(classify).toHaveBeenCalledTimes(1)
		expect(events[0]).toEqual({ kind: "start", modelId: "snps-provider/third" })
	})

	it("does not consult the classifier for a request with images", async () => {
		const classify = vi.fn(async () => ({ tier: "code" as const, think: false }))
		const model = createRoutedAgentModel({
			rules: () => rules(),
			features: () => ({ ...features(), hasImages: true }),
			knownModels: () => undefined,
			isHealthy: () => true,
			createDelegate: () => scripted([TEXT, STOP]),
			observer: recordingObserver().observer,
			classify,
		})
		await collect(model)
		expect(classify).not.toHaveBeenCalled()
	})

	it("reports when the first content arrived", async () => {
		let clock = 1_000
		const timings: unknown[] = []
		const slow: AgentModel = {
			async *stream() {
				clock = 1_250
				yield TEXT
				clock = 1_900
				yield STOP
			},
		}
		const model = createRoutedAgentModel({
			rules: () => rules(),
			features,
			knownModels: () => undefined,
			isHealthy: () => true,
			createDelegate: () => slow,
			observer: { ...recordingObserver().observer, onCallSuccess: ({ timing }) => timings.push(timing) },
			now: () => clock,
		})
		await collect(model)
		expect(timings).toEqual([{ startedAt: 1_000, firstContentAt: 1_250, endedAt: 1_900 }])
	})

	it("reports what each call produced: finish reason, text, reasoning and distinct tool calls", async () => {
		const shapes: unknown[] = []
		const acting: AgentModel = {
			async *stream(): AsyncGenerator<AgentModelEvent> {
				yield { type: "reasoning-delta", text: "think " }
				yield TEXT
				yield { type: "tool-call-delta", toolCallId: "c1", toolName: "read", inputText: "{" }
				yield { type: "tool-call-delta", toolCallId: "c1", inputText: "}" }
				yield { type: "tool-call-delta", toolCallId: "c2", toolName: "bash", input: {} }
				yield { type: "finish", reason: "tool-calls" }
			},
		}
		const model = createRoutedAgentModel({
			rules: () => rules(),
			features,
			knownModels: () => undefined,
			isHealthy: () => true,
			createDelegate: () => acting,
			observer: { ...recordingObserver().observer, onCallSuccess: ({ shape }) => shapes.push(shape) },
		})
		await collect(model)
		expect(shapes).toEqual([{ finishReason: "tool-calls", textChars: 5, reasoningChars: 6, toolCalls: 2 }])

		// The stall signature: text only, clean stop, nothing on the reasoning channel.
		const stalled: unknown[] = []
		const textOnly = createRoutedAgentModel({
			rules: () => rules(),
			features,
			knownModels: () => undefined,
			isHealthy: () => true,
			createDelegate: () => scripted([TEXT, STOP]),
			observer: { ...recordingObserver().observer, onCallSuccess: ({ shape }) => stalled.push(shape) },
		})
		await collect(textOnly)
		expect(stalled).toEqual([{ finishReason: "stop", textChars: 5, reasoningChars: 0, toolCalls: 0 }])
	})

	it("errors cleanly when the policy yields no candidates", async () => {
		const { model } = build({
			delegates: {},
			configured: rules({ pool: [], routes: [{ name: "empty", use: [] }] }),
		})
		const out = await collect(model)
		expect(out[0]).toMatchObject({ type: "finish", reason: "error", errorRetryable: false })
	})

	it("builds each delegate once and reuses it", async () => {
		const createDelegate = vi.fn(() => scripted([TEXT, STOP]))
		const { observer } = recordingObserver()
		const model = createRoutedAgentModel({
			rules: () => rules(),
			features,
			knownModels: () => undefined,
			isHealthy: () => true,
			createDelegate,
			observer,
		})
		await collect(model)
		await collect(model)
		expect(createDelegate).toHaveBeenCalledTimes(1)
	})

	it("skips models the health registry has benched", async () => {
		const { model, events } = build({
			delegates: { "snps-provider/second": scripted([TEXT, STOP]) },
			isHealthy: (id) => id !== "snps-provider/first",
		})
		expect(await collect(model)).toEqual([TEXT, STOP])
		expect(events[0]).toEqual({ kind: "start", modelId: "snps-provider/second" })
	})

	it("aborts a stream that produces nothing within the first-token budget", async () => {
		// Models a hung request: quiet for far longer than the budget, but still
		// eventually settling so the test process can exit.
		const stalling: AgentModel = {
			async *stream() {
				await new Promise((resolve) => setTimeout(resolve, 5_000))
				yield TEXT
			},
		}
		const configured = rules({
			health: { ...defaultRules().health, firstTokenTimeoutMs: 20, stallTimeoutMs: 20 },
		})
		const { model } = build({
			delegates: { "snps-provider/first": stalling, "snps-provider/second": scripted([TEXT, STOP]) },
			configured,
		})
		expect(await collect(model)).toEqual([TEXT, STOP])
	})
})
