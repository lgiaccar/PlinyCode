import type { ClineApiReqInfo, ClineMessage, ClineSubagentUsageInfo } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import TokenUsagePanel from "./TokenUsagePanel"
import { formatPercent, formatTokens, getApiCallUsages, getSideUsage, groupCallsByModel, summarizeApiCalls } from "./tokenUsage"

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

function usageRow(info: ClineSubagentUsageInfo): ClineMessage {
	return { ts: nextTs++, type: "say", say: "subagent_usage", text: JSON.stringify(info), partial: false }
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

	it("groups calls by the model that served them, in order of first use", () => {
		const calls = getApiCallUsages([...conversation, apiReq({ tokensIn: 5, tokensOut: 1 })])
		const groups = groupCallsByModel(calls, "pliny/auto-paid-balanced")
		expect(groups.map((g) => [g.modelId, g.calls.length])).toEqual([
			[SONNET, 2],
			[KIMI, 1],
			["pliny/auto-paid-balanced", 1],
		])
	})

	it("splits the usage outside the main agent's calls by source, in a fixed order", () => {
		const side = getSideUsage([
			usageRow({ source: "compaction", tokensIn: 50, tokensOut: 10, cacheReads: 0, cacheWrites: 0, cost: 0 }),
			usageRow({
				source: "advisor",
				tokensIn: 100,
				tokensOut: 20,
				cacheReads: 0,
				cacheWrites: 0,
				cost: 0.2,
				estimated: true,
			}),
			usageRow({ source: "subagents", tokensIn: 300, tokensOut: 30, cacheReads: 10, cacheWrites: 5, cost: 0.4 }),
			usageRow({ source: "advisor", tokensIn: 100, tokensOut: 20, cacheReads: 0, cacheWrites: 0, cost: 0.1 }),
		])
		expect(side.map((entry) => [entry.label, entry.rows, entry.tokens, entry.estimated])).toEqual([
			["Sub-agents", 1, 345, false],
			["Advisor", 2, 240, true],
			["Compaction", 1, 60, false],
		])
		expect(side[1].cost).toBeCloseTo(0.3)
	})

	it("formats compactly", () => {
		expect([formatTokens(812), formatTokens(18_557), formatTokens(3_912_000)]).toEqual(["812", "19k", "3.9M"])
		expect([formatPercent(0.099), formatPercent(0.6)]).toEqual(["9.9%", "60%"])
	})
})

describe("TokenUsagePanel", () => {
	beforeEach(() => {
		// The test DOM has no localStorage; the panel keeps its fold state there.
		const store = new Map<string, string>()
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key),
		})
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("renders nothing before the first call", () => {
		const { container } = render(<TokenUsagePanel clineMessages={[conversation[0]]} showCost />)
		expect(container).toBeEmptyDOMElement()
	})

	it("shows a bar per call and the conversation summary", () => {
		render(<TokenUsagePanel clineMessages={conversation} selectedModelId="pliny/auto-paid-balanced" showCost />)

		expect(screen.getAllByTestId("token-usage-bar")).toHaveLength(3)
		const lines = screen.getByTestId("token-usage-lines")
		expect(lines).toHaveTextContent("2 models")
		expect(lines).toHaveTextContent("3 calls · $0.07")
		expect(lines).toHaveTextContent("In 21k · Out 550 · Reason 30")
		expect(lines).toHaveTextContent("Cache R 13k · W 15k · Hit rate 27%")
	})

	it("offers a chip per routed model that narrows the summary and dims the other bars", () => {
		render(<TokenUsagePanel clineMessages={conversation} selectedModelId="pliny/auto-paid-balanced" showCost />)

		const chips = screen.getAllByRole("button", { pressed: false }).concat(screen.getAllByRole("button", { pressed: true }))
		expect(chips.map((chip) => chip.textContent).sort()).toEqual(["All models", "Claude Sonnet 5 ×2", "kimi-k2.6 ×1"])

		fireEvent.click(screen.getByRole("button", { name: "Claude Sonnet 5 ×2" }))

		const lines = screen.getByTestId("token-usage-lines")
		expect(lines).toHaveTextContent("Claude Sonnet 5")
		expect(lines).toHaveTextContent("2 of 3 calls · $0.07")
		expect(lines).toHaveTextContent("Cache R 13k · W 15k · Hit rate 45%")
		const dimmed = screen.getAllByTestId("token-usage-bar").map((bar) => bar.hasAttribute("data-dimmed"))
		expect(dimmed).toEqual([false, false, true])

		// Clicking the selected chip again shows every model.
		fireEvent.click(screen.getByRole("button", { name: "Claude Sonnet 5 ×2" }))
		expect(screen.getByTestId("token-usage-lines")).toHaveTextContent("3 calls")
	})

	it("shows no model chips when a single model served every call", () => {
		render(
			<TokenUsagePanel
				clineMessages={[apiReq({ tokensIn: 10, tokensOut: 5, modelId: SONNET }), apiReq({ tokensIn: 20, tokensOut: 5 })]}
				selectedModelId={SONNET}
				showCost={false}
			/>,
		)
		expect(screen.queryByRole("group", { name: "Filter by model" })).not.toBeInTheDocument()
		expect(screen.getByTestId("token-usage-lines")).toHaveTextContent("Claude Sonnet 5")
	})

	it("folds down to its header, keeps the totals there, and remembers the choice", () => {
		const { unmount } = render(<TokenUsagePanel clineMessages={conversation} showCost />)
		const header = screen.getByRole("button", { name: /Token usage/ })
		expect(header).toHaveAttribute("aria-expanded", "true")
		expect(header).toHaveTextContent("Token usage · 3 calls · $0.07 · Hit rate 27%")

		fireEvent.click(header)

		expect(header).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryAllByTestId("token-usage-bar")).toHaveLength(0)
		expect(screen.queryByTestId("token-usage-lines")).not.toBeInTheDocument()

		unmount()
		render(<TokenUsagePanel clineMessages={conversation} showCost />)
		expect(screen.getByRole("button", { name: /Token usage/ })).toHaveAttribute("aria-expanded", "false")
		fireEvent.click(screen.getByRole("button", { name: /Token usage/ }))
		expect(screen.getAllByTestId("token-usage-bar")).toHaveLength(3)
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

	it("shows sub-agent, advisor and compaction usage on a labelled line each", () => {
		render(
			<TokenUsagePanel
				clineMessages={[
					...conversation,
					usageRow({ source: "advisor", tokensIn: 3_000, tokensOut: 400, cacheReads: 0, cacheWrites: 0, cost: 0.03 }),
					usageRow({
						source: "subagents",
						tokensIn: 10_000,
						tokensOut: 900,
						cacheReads: 2_000,
						cacheWrites: 0,
						cost: 0.1,
					}),
					usageRow({ source: "advisor", tokensIn: 1_000, tokensOut: 100, cacheReads: 0, cacheWrites: 0, cost: 0.01 }),
				]}
				showCost
			/>,
		)

		const side = screen.getAllByTestId("token-usage-side").map((line) => line.textContent)
		expect(side).toEqual(["Sub-agents13k tokens · $0.10", "Advisor×2 · 4.5k tokens · $0.04"])
		// The main agent's summary leaves them out.
		expect(screen.getByTestId("token-usage-lines")).toHaveTextContent("3 calls · $0.07")
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
