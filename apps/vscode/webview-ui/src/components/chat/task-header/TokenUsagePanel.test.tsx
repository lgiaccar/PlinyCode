import type { ClineApiReqInfo, ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import TokenUsagePanel from "./TokenUsagePanel"
import { formatPercent, formatTokens, getApiCallUsages, summarizeApiCalls } from "./tokenUsage"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		providerModelsByProvider: {
			pliny: { models: { "snps-aws-bedrock/global.anthropic.claude-sonnet-5": { name: "Claude Sonnet 5" } } },
		},
	}),
}))

let nextTs = 1
function apiReq(info: ClineApiReqInfo): ClineMessage {
	return { ts: nextTs++, type: "say", say: "api_req_started", text: JSON.stringify(info), partial: false }
}

const SONNET = "snps-aws-bedrock/global.anthropic.claude-sonnet-5"
const KIMI = "snps-provider/kimi-k2.6"

const conversation: ClineMessage[] = [
	{ ts: nextTs++, type: "say", say: "task", text: "do it" },
	// The spinner row of a live call carries no usage and is not a call.
	apiReq({}),
	apiReq({ tokensIn: 2, tokensOut: 100, cacheReads: 0, cacheWrites: 13_000, cost: 0.05, modelId: SONNET }),
	apiReq({
		tokensIn: 1_000,
		tokensOut: 50,
		cacheReads: 13_000,
		cacheWrites: 2_000,
		cost: 0.02,
		modelId: SONNET,
		reasoningTokens: 30,
	}),
	apiReq({ tokensIn: 20_000, tokensOut: 400, cost: 0, modelId: KIMI }),
	apiReq({ streamingFailedMessage: "boom" }),
]

describe("tokenUsage", () => {
	it("reads one call per api_req_started row that carries usage", () => {
		const calls = getApiCallUsages(conversation)
		expect(calls.map((c) => [c.modelId, c.tokensIn, c.cacheReads, c.cacheWrites])).toEqual([
			[SONNET, 2, 0, 13_000],
			[SONNET, 1_000, 13_000, 2_000],
			[KIMI, 20_000, 0, 0],
		])
	})

	it("sums the calls and computes the cache hit rate over all prompt tokens", () => {
		const summary = summarizeApiCalls(getApiCallUsages(conversation))
		expect(summary).toMatchObject({
			calls: 3,
			tokensIn: 21_002,
			tokensOut: 550,
			cacheReads: 13_000,
			cacheWrites: 15_000,
			reasoningTokens: 30,
			models: [
				{ modelId: SONNET, calls: 2 },
				{ modelId: KIMI, calls: 1 },
			],
		})
		expect(summary.cost).toBeCloseTo(0.07)
		expect(summary.cacheHitRate).toBeCloseTo(13_000 / 49_002)
	})

	it("formats compactly", () => {
		expect([formatTokens(812), formatTokens(18_557), formatTokens(3_912_000)]).toEqual(["812", "19k", "3.9M"])
		expect([formatPercent(0.099), formatPercent(0.6)]).toEqual(["9.9%", "60%"])
	})
})

describe("TokenUsagePanel", () => {
	it("renders nothing before the first call", () => {
		const { container } = render(<TokenUsagePanel clineMessages={[conversation[0]]} showCost />)
		expect(container).toBeEmptyDOMElement()
	})

	it("shows a bar per call and the conversation summary with routed model names", () => {
		render(<TokenUsagePanel clineMessages={conversation} selectedModelId="pliny/auto-paid-balanced" showCost />)

		expect(screen.getAllByTestId("token-usage-bar")).toHaveLength(3)
		const lines = screen.getByTestId("token-usage-lines")
		expect(lines).toHaveTextContent("Claude Sonnet 5 ×2 · kimi-k2.6 ×1")
		expect(lines).toHaveTextContent("3 calls · $0.07")
		expect(lines).toHaveTextContent("In 21k · Out 550 · Reason 30")
		expect(lines).toHaveTextContent("Cache R 13k · W 15k · Hit rate 27%")
	})

	it("switches the summary to the hovered call", () => {
		render(<TokenUsagePanel clineMessages={conversation} showCost />)

		fireEvent.mouseEnter(screen.getAllByTestId("token-usage-bar")[1])

		const lines = screen.getByTestId("token-usage-lines")
		expect(lines).toHaveTextContent("Claude Sonnet 5")
		expect(lines).toHaveTextContent("Call 2 of 3 · $0.02")
		expect(lines).toHaveTextContent("Cache R 13k · W 2.0k · Hit rate 81%")
	})

	it("hides cost when the provider does not show it", () => {
		render(<TokenUsagePanel clineMessages={conversation} showCost={false} />)
		expect(screen.getByTestId("token-usage-lines")).not.toHaveTextContent("$")
	})

	it("names calls without a model after the selected model", () => {
		render(
			<TokenUsagePanel
				clineMessages={[apiReq({ tokensIn: 10, tokensOut: 5 })]}
				selectedModelId="pliny/auto-free"
				showCost={false}
			/>,
		)
		expect(screen.getByTestId("token-usage-lines")).toHaveTextContent("FreeAuto")
	})
})
