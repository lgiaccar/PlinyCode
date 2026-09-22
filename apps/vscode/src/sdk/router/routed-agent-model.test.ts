import type { AgentModel, AgentModelEvent, AgentModelRequest } from "@plinycode/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createRoutedAgentModel, type RouterObserver } from "./routed-agent-model"
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
	return { estimatedTokens: 100, mode: "act", prompt: "do the thing", hasImages: false, callIndex: 1 }
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
}) {
	const { observer, events } = recordingObserver()
	const model = createRoutedAgentModel({
		rules: () => options.configured ?? rules(),
		features,
		knownModels: () => undefined,
		isHealthy: options.isHealthy ?? (() => true),
		createDelegate: (modelId) => options.delegates[modelId] ?? scripted([{ type: "finish", reason: "stop" }]),
		observer: options.observer ?? observer,
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
