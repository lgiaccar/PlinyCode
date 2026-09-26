import type { ModelInfo } from "@shared/api"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ModelDetailsCard } from "./ModelDetailsCard"

const info = (overrides: Partial<ModelInfo>): ModelInfo => ({ supportsPromptCache: false, ...overrides })

describe("ModelDetailsCard", () => {
	it("shows summary, context, MoE parameters and free pricing for a self-hosted model", () => {
		render(
			<ModelDetailsCard
				modelId="snps-provider/kimi-k2.6"
				modelInfo={info({
					name: "Kimi K2.6",
					description: "Fast, strong agentic coder.\n\nSelf-hosted via Pliny · pool: snps-provider",
					contextWindow: 256_000,
					maxTokens: 64_000,
					inputPrice: 0,
					outputPrice: 0,
					cacheReadsPrice: 0,
					parameters: { totalB: 1000, activeB: 32 },
					pricingNote: "Free: self-hosted, not counted against your Pliny budget",
				})}
			/>,
		)
		expect(screen.getByText("Kimi K2.6")).toBeTruthy()
		expect(screen.getByText("Fast, strong agentic coder.")).toBeTruthy()
		expect(screen.getByText("Self-hosted via Pliny · pool: snps-provider")).toBeTruthy()
		expect(screen.getByText("256K tokens · max output 64K")).toBeTruthy()
		expect(screen.getByText("1T total · 32B active per token")).toBeTruthy()
		expect(screen.getAllByText("Free").length).toBeGreaterThanOrEqual(3)
	})

	it("shows paid prices including cached input and cache write, and 'Not disclosed' for closed models", () => {
		render(
			<ModelDetailsCard
				modelId="snps-aws-bedrock/aws-claude-sonnet-4.6"
				modelInfo={info({
					name: "Claude Sonnet 4.6",
					contextWindow: 1_000_000,
					maxTokens: 64_000,
					inputPrice: 3,
					outputPrice: 15,
					cacheReadsPrice: 0.3,
					cacheWritesPrice: 3.75,
					supportsImages: true,
				})}
			/>,
		)
		expect(screen.getByText("1M tokens · max output 64K")).toBeTruthy()
		expect(screen.getByText("Not disclosed")).toBeTruthy()
		expect(screen.getByText("$3.00 / 1M tokens")).toBeTruthy()
		expect(screen.getByText("$0.30 / 1M tokens")).toBeTruthy()
		expect(screen.getByText("$3.75 / 1M tokens")).toBeTruthy()
		expect(screen.getByText("$15.00 / 1M tokens")).toBeTruthy()
		expect(screen.getByText("Paid")).toBeTruthy()
		expect(screen.getByText("Images")).toBeTruthy()
	})

	it("says the price is unknown instead of free when no price is listed", () => {
		render(
			<ModelDetailsCard
				modelId="azure-openai/gpt-5.6-terra"
				modelInfo={info({
					name: "GPT-5.6 Terra",
					contextWindow: 200_000,
					inputPrice: 0,
					outputPrice: 0,
					pricingUnavailable: true,
				})}
			/>,
		)
		expect(screen.getByText("Unknown")).toBeTruthy()
		expect(screen.queryByText("Free")).toBeNull()
	})

	it("describes a paid router's cost and size as depending on the routed model", () => {
		render(
			<ModelDetailsCard
				modelId="pliny/auto-paid-balanced"
				modelInfo={info({
					name: "auto-paid-balanced (router)",
					contextWindow: 200_000,
					pricingUnavailable: true,
					pricingNote: "Each call is billed at the price of the model it lands on",
				})}
			/>,
		)
		expect(screen.getByText("Router")).toBeTruthy()
		expect(screen.getByText("Depends on the routed model")).toBeTruthy()
		expect(screen.getByText("Varies by routed model")).toBeTruthy()
		expect(screen.getByText("Each call is billed at the price of the model it lands on")).toBeTruthy()
	})
})
