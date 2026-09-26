import type { ModelInfo } from "@shared/api"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ConversationModelPicker } from "./ConversationModelPicker"

const models: Record<string, ModelInfo> = {
	"pliny/auto-free": {
		name: "auto-free (router)",
		description: "Free default router.",
		contextWindow: 256_000,
		maxTokens: 32_768,
		inputPrice: 0,
		outputPrice: 0,
		supportsPromptCache: false,
		pricingNote: "Free: routes only to self-hosted models",
	},
	"snps-aws-bedrock/aws-claude-sonnet-4.6": {
		name: "Claude Sonnet 4.6",
		description: "Excellent coder with a 1M-token context.\n\nHosted via Pliny · pool: snps-aws-bedrock",
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		inputPrice: 3,
		outputPrice: 15,
		cacheReadsPrice: 0.3,
		supportsPromptCache: true,
	},
	"azure-openai/gpt-5.6-terra": {
		name: "GPT-5.6 Terra",
		contextWindow: 200_000,
		inputPrice: 0,
		outputPrice: 0,
		supportsPromptCache: false,
		pricingUnavailable: true,
	},
}

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ favoritedModelIds: [] }),
}))
vi.mock("@/hooks/useNormalizedApiConfiguration", () => ({
	useNormalizedApiConfiguration: () => ({ selectedModelId: "snps-aws-bedrock/aws-claude-sonnet-4.6" }),
}))
vi.mock("@/hooks/useProviderModels", () => ({
	useProviderModels: () => ({ models }),
}))
vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: () => ({ commitSelection: vi.fn(async () => undefined) }),
}))
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { toggleFavoriteModel: vi.fn(async () => ({})) },
}))

describe("ConversationModelPicker", () => {
	it("shows the selected model's display name on the trigger", () => {
		render(<ConversationModelPicker mode="act" />)
		expect(screen.getByRole("button", { name: /Claude Sonnet 4\.6/ })).toBeTruthy()
	})

	it("summarises context and price on each row, never calling an unpriced model free", () => {
		render(<ConversationModelPicker mode="act" />)
		fireEvent.click(screen.getByRole("button", { name: /Claude Sonnet 4\.6/ }))

		const rows = screen.getAllByRole("option")
		const rowText = (name: string) => rows.find((row) => row.textContent?.includes(name))?.textContent
		expect(rowText("auto-free (router)")).toContain("256K · Free")
		expect(rowText("Claude Sonnet 4.6")).toContain("1M · $3/$15")
		expect(rowText("GPT-5.6 Terra")).toContain("200K · price ?")
	})

	it("shows the details card for the hovered row and hides it when the pointer leaves the list", () => {
		render(<ConversationModelPicker mode="act" />)
		fireEvent.click(screen.getByRole("button", { name: /Claude Sonnet 4\.6/ }))
		expect(screen.queryByTestId("model-details-card")).toBeNull()

		const sonnetRow = screen.getAllByRole("option").find((row) => row.textContent?.includes("Claude Sonnet 4.6"))
		fireEvent.mouseEnter(sonnetRow as HTMLElement)
		const card = screen.getByTestId("model-details-card")
		expect(card.textContent).toContain("Excellent coder with a 1M-token context.")
		expect(card.textContent).toContain("$0.30 / 1M tokens")

		fireEvent.mouseLeave(screen.getByRole("listbox"))
		expect(screen.queryByTestId("model-details-card")).toBeNull()
	})
})
