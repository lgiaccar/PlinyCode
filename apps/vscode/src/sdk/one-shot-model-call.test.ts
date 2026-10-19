import type { ModelInfo } from "@plinycode/llms"
import type { AgentModelRequest } from "@plinycode/shared"
import { describe, expect, it } from "vitest"
import { resolveCallUsage } from "./one-shot-model-call"

const SELF_HOSTED_MODEL = "snps-provider/qwen3-coder-480b-a35b-inst-fp8"
const PAID_MODEL = "anthropic/claude-sonnet-5"
const PAID_INFO = { id: PAID_MODEL, pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } as ModelInfo

function request(): AgentModelRequest {
	return { messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: 0 }], tools: [] }
}

describe("resolveCallUsage", () => {
	it("forces a self-hosted model's cost to zero even when the gateway reported one", () => {
		const usage = resolveCallUsage(
			{ text: "ok", usage: { inputTokens: 100, outputTokens: 20, totalCost: 0.02 } },
			request(),
			SELF_HOSTED_MODEL,
			undefined,
		)
		expect(usage).toEqual({
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalCost: 0,
		})
	})

	it("stays free for a self-hosted model that reported no cost at all", () => {
		const usage = resolveCallUsage(
			{ text: "ok", usage: { inputTokens: 100, outputTokens: 20 } },
			request(),
			SELF_HOSTED_MODEL,
			undefined,
		)
		expect(usage?.totalCost).toBe(0)
	})

	it("keeps a paid model's gateway-reported cost", () => {
		const usage = resolveCallUsage(
			{ text: "ok", usage: { inputTokens: 1_000, outputTokens: 500, totalCost: 0.012 } },
			request(),
			PAID_MODEL,
			PAID_INFO,
		)
		expect(usage?.totalCost).toBe(0.012)
	})

	it("prices a paid model from the catalog when the gateway reported tokens but no cost", () => {
		const usage = resolveCallUsage(
			{ text: "ok", usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
			request(),
			PAID_MODEL,
			PAID_INFO,
		)
		expect(usage?.totalCost).toBeCloseTo(3 + 15, 5)
	})
})
