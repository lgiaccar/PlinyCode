import type { ModelInfo } from "@plinycode/llms"
import type { AgentMessage, AgentModel, AgentModelEvent, AgentModelRequest } from "@plinycode/shared"
import { describe, expect, it, vi } from "vitest"
import { createRoutedAgentModel, type RouterObserver } from "./routed-agent-model"
import {
	beginImageTurn,
	createRouterImageHandler,
	type RouterImageMode,
	type RouterImageNotice,
	requestHasImages,
} from "./router-images"
import { defaultRules } from "./router-rules"
import type { RouterRules } from "./router-types"

const FREE_A = "snps-provider/free-a"
const FREE_B = "snps-provider/free-b"
const HAIKU = "snps-aws-bedrock/haiku"
const SONNET = "snps-aws-bedrock/sonnet"
const GPT = "azure-openai/gpt"
const FREE_VISION = "snps-provider/free-vision"

// A 1x1 PNG, and a second, different image.
const PNG_1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const PNG_2 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

function info(id: string, options: { images?: boolean; input?: number; output?: number; router?: boolean } = {}): ModelInfo {
	return {
		id,
		name: id.split("/")[1],
		capabilities: ["streaming", "tools", ...(options.images ? (["images"] as const) : [])],
		...(options.input !== undefined ? { pricing: { input: options.input, output: options.output ?? 0 } } : {}),
		...(options.router ? { metadata: { router: true } } : {}),
	} as ModelInfo
}

const CATALOG: Record<string, ModelInfo> = {
	[FREE_A]: info(FREE_A),
	[FREE_B]: info(FREE_B),
	[SONNET]: info(SONNET, { images: true, input: 3, output: 15 }),
	[HAIKU]: info(HAIKU, { images: true, input: 1, output: 5 }),
	[GPT]: info(GPT, { images: true, input: 1.75, output: 14 }),
	"pliny/auto-paid-balanced": info("pliny/auto-paid-balanced", { images: true, router: true }),
}

const STOP: AgentModelEvent = { type: "finish", reason: "stop" }

function rules(pool: string[]): RouterRules {
	return { ...defaultRules(), pool, routes: [{ name: "test", use: pool }], sticky: false }
}

function userImage(image: string, text = "why is this button misaligned?"): AgentMessage {
	return {
		id: `u-${image.slice(-8)}`,
		role: "user",
		content: [
			{ type: "text", text },
			{ type: "image", image, mediaType: "image/png" },
		],
		createdAt: 0,
	}
}

function request(...messages: AgentMessage[]): AgentModelRequest {
	return { systemPrompt: "system", messages, tools: [] }
}

/** A delegate that records every request it is sent and answers with text. */
function recording(reply = "ok"): AgentModel & { requests: AgentModelRequest[] } {
	const requests: AgentModelRequest[] = []
	return {
		requests,
		async *stream(req) {
			requests.push(req)
			yield { type: "text-delta", text: reply }
			yield STOP
		},
	}
}

/** The describer: answers with a description and reports usage, as the gateway does. */
function describer(text = "A dialog titled Error with the text: Build failed."): AgentModel & { calls: number } {
	const model = {
		calls: 0,
		async *stream(): AsyncGenerator<AgentModelEvent> {
			model.calls += 1
			yield { type: "text-delta", text }
			yield { type: "usage", usage: { inputTokens: 1600, outputTokens: 120, totalCost: 0.0022 } }
			yield STOP
		},
	}
	return model
}

const NOOP_OBSERVER: RouterObserver = {
	onCallStart: () => undefined,
	onFailover: () => undefined,
	onCallSuccess: () => undefined,
	onCallError: () => undefined,
}

let conversationCounter = 0

function setup(options: {
	mode?: RouterImageMode
	paidAllowed?: boolean
	pool?: string[]
	catalog?: Record<string, ModelInfo>
	budget?: string
	describerModel?: AgentModel
}) {
	const key = `conversation-${++conversationCounter}`
	const pool = options.pool ?? [FREE_A, FREE_B]
	const delegates = new Map<string, ReturnType<typeof recording>>()
	const delegate = (id: string) => {
		let model = delegates.get(id)
		if (!model) {
			model = recording(`answer from ${id}`)
			delegates.set(id, model)
		}
		return model
	}
	const describers = new Map<string, AgentModel>()
	const describerFor = (id: string) => {
		let model = describers.get(id)
		if (!model) {
			model = options.describerModel ?? describer()
			describers.set(id, model)
		}
		return model
	}
	const notices: RouterImageNotice[] = []
	const usages: Array<{ modelId: string; sha: string; cost: number }> = []
	const checkBudget = vi.fn(async () => options.budget)
	const catalog = options.catalog ?? CATALOG
	const handler = createRouterImageHandler({
		conversationKey: () => key,
		mode: () => options.mode ?? "describe",
		paidAllowed: () => options.paidAllowed ?? true,
		knownModels: () => catalog,
		createModel: describerFor,
		checkBudget,
		onUsage: ({ modelId, sha, usage }) => usages.push({ modelId, sha, cost: usage.totalCost }),
		onNotice: (notice) => notices.push(notice),
	})
	const started: string[] = []
	const model = createRoutedAgentModel({
		rules: () => rules(pool),
		features: (req) => ({
			estimatedTokens: 100,
			mode: "act",
			prompt: "",
			hasImages: requestHasImages(req),
			isSubAgent: false,
			callIndex: 1,
		}),
		knownModels: () => catalog,
		isHealthy: () => true,
		createDelegate: delegate,
		observer: { ...NOOP_OBSERVER, onCallStart: ({ modelId }) => started.push(modelId) },
		planImages: (req) => handler.plan(req),
	})
	const run = async (req: AgentModelRequest) => {
		const events: AgentModelEvent[] = []
		for await (const event of await model.stream(req)) {
			events.push(event)
		}
		return events
	}
	beginImageTurn(key)
	return {
		run,
		delegate,
		describerFor,
		notices,
		usages,
		checkBudget,
		started,
		nextTurn: () => beginImageTurn(key),
	}
}

/** The text parts of the last user message a delegate received. */
function sentTexts(model: ReturnType<typeof recording>, index = -1): string[] {
	const req = model.requests.at(index)
	return (req?.messages ?? []).flatMap((message) =>
		message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
	)
}

function sentImages(model: ReturnType<typeof recording>, index = -1): number {
	const req = model.requests.at(index)
	return (req?.messages ?? []).reduce(
		(count, message) => count + message.content.filter((part) => part.type === "image").length,
		0,
	)
}

describe("router image handling: describe", () => {
	it("describes a new image once with the cheapest image model and sends the free model the description", async () => {
		const { run, delegate, describerFor, notices, usages, started } = setup({})
		const events = await run(request(userImage(PNG_1)))

		expect(events.at(-1)).toEqual(STOP)
		expect(started).toEqual([FREE_A])
		expect((describerFor(HAIKU) as ReturnType<typeof describer>).calls).toBe(1)
		const texts = sentTexts(delegate(FREE_A))
		expect(sentImages(delegate(FREE_A))).toBe(0)
		expect(texts.some((text) => /^<image_description sha="[0-9a-f]{12}">\nA dialog titled Error/.test(text))).toBe(true)
		expect(usages).toEqual([{ modelId: HAIKU, sha: expect.stringMatching(/^[0-9a-f]{12}$/), cost: 0.0022 }])
		expect(notices).toEqual([{ kind: "described", modelId: HAIKU, count: 1, cost: 0.0022 }])
	})

	it("does not describe an image again when the history is re-sent, and describes only the new one", async () => {
		const { run, delegate, describerFor, notices, usages } = setup({})
		await run(request(userImage(PNG_1)))
		await run(request(userImage(PNG_1)))
		const haiku = describerFor(HAIKU) as ReturnType<typeof describer>
		expect(haiku.calls).toBe(1)

		await run(request(userImage(PNG_1), userImage(PNG_2, "and this one?")))
		expect(haiku.calls).toBe(2)
		expect(usages).toHaveLength(2)
		const descriptions = sentTexts(delegate(FREE_A)).filter((text) => text.startsWith("<image_description"))
		expect(descriptions).toHaveLength(2)
		expect(new Set(descriptions.map((text) => text.slice(0, 40))).size).toBe(2)
		// The notice is shown the first time only.
		expect(notices.filter((notice) => notice.kind === "described")).toHaveLength(1)
	})

	it("describes an image a tool returned, inside the tool result", async () => {
		const { run, delegate, describerFor } = setup({})
		const toolTurn: AgentMessage = {
			id: "t",
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "c1",
					toolName: "view_image",
					output: [
						{ type: "text", text: "Image shot.png (PNG, 1×1, 1 KB)" },
						{ type: "image", data: PNG_1, mediaType: "image/png" },
					],
				},
			],
			createdAt: 0,
		}
		await run(
			request({ id: "u", role: "user", content: [{ type: "text", text: "look at shot.png" }], createdAt: 0 }, toolTurn),
		)

		expect((describerFor(HAIKU) as ReturnType<typeof describer>).calls).toBe(1)
		const sent = delegate(FREE_A).requests[0]?.messages[1]?.content[0]
		expect(sent?.type).toBe("tool-result")
		const output = (sent as { output: Array<{ type: string; text?: string }> }).output
		expect(output[0]).toEqual({ type: "text", text: "Image shot.png (PNG, 1×1, 1 KB)" })
		expect(output[1]?.type).toBe("text")
		expect(output[1]?.text).toMatch(/^<image_description sha=/)
	})

	it("sends an image-capable candidate the image untouched", async () => {
		const { run, delegate, describerFor } = setup({ pool: [SONNET, FREE_A] })
		await run(request(userImage(PNG_1)))
		expect(sentImages(delegate(SONNET))).toBe(1)
		expect(delegate(FREE_A).requests).toHaveLength(0)
		expect((describerFor(HAIKU) as ReturnType<typeof describer>).calls).toBe(0)
	})

	it("prefers a free image-capable model, even with paid models locked", async () => {
		const catalog = { ...CATALOG, [FREE_VISION]: info(FREE_VISION, { images: true }) }
		const { run, delegate, describerFor, checkBudget, notices } = setup({ catalog, paidAllowed: false })
		await run(request(userImage(PNG_1)))
		expect((describerFor(FREE_VISION) as ReturnType<typeof describer>).calls).toBe(1)
		expect(sentTexts(delegate(FREE_A)).some((text) => text.startsWith("<image_description"))).toBe(true)
		// A free description spends nothing, so the budget is not asked.
		expect(checkBudget).not.toHaveBeenCalled()
		expect(notices[0]).toMatchObject({ kind: "described", modelId: FREE_VISION })
	})

	it("falls back to a note when paid models are locked and no free model can see images", async () => {
		const { run, delegate, describerFor, notices, usages } = setup({ paidAllowed: false })
		await run(request(userImage(PNG_1)))
		expect((describerFor(HAIKU) as ReturnType<typeof describer>).calls).toBe(0)
		const texts = sentTexts(delegate(FREE_A))
		expect(texts.some((text) => text.includes("An image was attached here but is not shown to you"))).toBe(true)
		expect(texts.some((text) => text.includes("paid models are locked"))).toBe(true)
		expect(usages).toEqual([])
		expect(notices).toEqual([{ kind: "paid-locked", mode: "describe" }])
	})

	it("does not describe when the conversation's budget is spent", async () => {
		const { run, delegate, describerFor, notices, checkBudget } = setup({ budget: "This conversation has spent $5.00." })
		await run(request(userImage(PNG_1)))
		expect(checkBudget).toHaveBeenCalledTimes(1)
		expect((describerFor(HAIKU) as ReturnType<typeof describer>).calls).toBe(0)
		expect(sentTexts(delegate(FREE_A)).some((text) => text.includes("exceed this conversation's budget"))).toBe(true)
		expect(notices).toEqual([{ kind: "budget", reason: "This conversation has spent $5.00." }])
	})

	it("replaces an image that could not be described with a note and does not retry it within the turn", async () => {
		const failing: AgentModel & { calls: number } = {
			calls: 0,
			async *stream() {
				failing.calls += 1
				yield { type: "finish", reason: "error", error: "upstream 500" }
			},
		}
		const { run, delegate, notices, nextTurn } = setup({ describerModel: failing })
		await run(request(userImage(PNG_1)))
		await run(request(userImage(PNG_1)))
		expect(failing.calls).toBe(1)
		expect(sentTexts(delegate(FREE_A)).some((text) => text.includes("it could not be described"))).toBe(true)
		expect(notices).toEqual([{ kind: "failed", modelId: HAIKU, error: "upstream 500" }])

		nextTurn()
		await run(request(userImage(PNG_1)))
		expect(failing.calls).toBe(2)
	})
})

describe("router image handling: vision-model", () => {
	it("runs a turn with a new image on the image model, then describes it on later turns", async () => {
		const { run, delegate, describerFor, started, notices, nextTurn } = setup({ mode: "vision-model" })
		await run(request(userImage(PNG_1)))
		expect(started).toEqual([HAIKU])
		expect(sentImages(delegate(HAIKU))).toBe(1)
		expect(notices).toEqual([{ kind: "vision-model", modelId: HAIKU }])

		// Later calls of the same turn stay on it.
		await run(request(userImage(PNG_1), { id: "a", role: "assistant", content: [{ type: "text", text: "…" }], createdAt: 0 }))
		expect(started).toEqual([HAIKU, HAIKU])

		nextTurn()
		await run(
			request(userImage(PNG_1), { id: "u2", role: "user", content: [{ type: "text", text: "thanks" }], createdAt: 0 }),
		)
		expect(started.at(-1)).toBe(FREE_A)
		expect((describerFor(HAIKU) as ReturnType<typeof describer>).calls).toBe(1)
		expect(sentTexts(delegate(FREE_A)).some((text) => text.startsWith("<image_description"))).toBe(true)
	})

	it("falls back to a note with paid models locked", async () => {
		const { run, delegate, started, notices } = setup({ mode: "vision-model", paidAllowed: false })
		await run(request(userImage(PNG_1)))
		expect(started).toEqual([FREE_A])
		expect(sentTexts(delegate(FREE_A)).some((text) => text.includes("An image was attached here but is not shown"))).toBe(
			true,
		)
		expect(notices).toEqual([{ kind: "paid-locked", mode: "vision-model" }])
	})
})

describe("router image handling: off", () => {
	it("drops the image and tells the model one was attached, without describing", async () => {
		const { run, delegate, describerFor, notices, usages } = setup({ mode: "off" })
		await run(request(userImage(PNG_1)))
		expect((describerFor(HAIKU) as ReturnType<typeof describer>).calls).toBe(0)
		expect(sentImages(delegate(FREE_A))).toBe(0)
		expect(sentTexts(delegate(FREE_A))).toContain(
			"[An image was attached here but is not shown to you: image input to this model is turned off (plinycode.router.images). Do not guess what it shows; if you need it, ask the user to describe it.]",
		)
		expect(usages).toEqual([])
		expect(notices).toEqual([{ kind: "off" }])
	})
})

describe("requestHasImages", () => {
	it("sees image parts and images nested in tool results, and nothing else", () => {
		expect(requestHasImages(request(userImage(PNG_1)))).toBe(true)
		expect(
			requestHasImages(
				request({
					id: "t",
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "c",
							toolName: "read_files",
							output: [
								{
									query: "a.png",
									result: ["Successfully read image", { type: "image", data: PNG_1, mediaType: "image/png" }],
								},
							],
						},
					],
					createdAt: 0,
				}),
			),
		).toBe(true)
		expect(requestHasImages(request({ id: "u", role: "user", content: [{ type: "text", text: "hi" }], createdAt: 0 }))).toBe(
			false,
		)
	})
})
