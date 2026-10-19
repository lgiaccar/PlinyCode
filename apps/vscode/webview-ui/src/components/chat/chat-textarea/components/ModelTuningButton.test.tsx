import type { ModelInfo } from "@shared/api"
import type { ModelTuningMap } from "@shared/model-tuning"
import { fireEvent, render, screen } from "@testing-library/react"
import type { PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ModelTuningButton } from "./ModelTuningButton"

const mocks = vi.hoisted(() => ({
	modelId: "snps-provider/GLM-5.2",
	modelInfo: {} as Partial<ModelInfo>,
	modelTuning: {} as ModelTuningMap,
	setModelTuning: vi.fn(async () => ({})),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ modelTuning: mocks.modelTuning }),
}))

vi.mock("@/hooks/useNormalizedApiConfiguration", () => ({
	useNormalizedApiConfiguration: () => ({
		selectedProvider: "pliny",
		selectedModelId: mocks.modelId,
		selectedModelInfo: mocks.modelInfo,
	}),
}))

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: { setModelTuning: mocks.setModelTuning },
}))

vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
	TooltipContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
	TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
}))

function open() {
	render(<ModelTuningButton mode="act" />)
	fireEvent.click(screen.getByTestId("model-tuning-button"))
}

const radios = (group: string) =>
	Array.from(screen.getByRole("radiogroup", { name: group }).querySelectorAll("[role=radio]"), (radio) => radio.textContent)

describe("ModelTuningButton", () => {
	beforeEach(() => {
		mocks.modelId = "snps-provider/GLM-5.2"
		mocks.modelInfo = {}
		mocks.modelTuning = {}
		mocks.setModelTuning.mockClear()
	})

	it("offers an off-switch, no effort and the context presets on a model that thinks by default", () => {
		mocks.modelInfo = { contextWindow: 512_000, thinkingControls: { defaultOn: true, off: "template-kwargs" } }
		open()
		expect(radios("Thinking")).toEqual(["Default", "Off"])
		expect(screen.queryByRole("radiogroup", { name: "Effort" })).toBeNull()
		expect(radios("Context")).toEqual(["Full", "128k", "64k", "32k"])
	})

	it("offers on and an effort level on a model whose switch is reasoning_effort", () => {
		mocks.modelId = "azure-openai/gpt-5.2"
		mocks.modelInfo = { contextWindow: 272_000, thinkingControls: { defaultOn: false, on: "reasoning-effort" } }
		open()
		expect(radios("Thinking")).toEqual(["Default", "On"])
		expect(radios("Effort")).toEqual(["Default", "Low", "Medium", "High"])

		fireEvent.click(screen.getByRole("radio", { name: "High" }))
		expect(mocks.setModelTuning).toHaveBeenCalledWith(
			expect.objectContaining({ modelId: "azure-openai/gpt-5.2", effort: "high" }),
		)
	})

	it("gives a router the context budget only, below its own", () => {
		mocks.modelId = "pliny/auto-free"
		mocks.modelInfo = { contextWindow: 256_000, maxInputTokens: 92_000 }
		open()
		expect(screen.queryByRole("radiogroup", { name: "Thinking" })).toBeNull()
		expect(radios("Context")).toEqual(["Full", "64k", "32k"])
		expect(screen.getByText(/chosen per turn by the router/)).toBeTruthy()

		fireEvent.click(screen.getByRole("radio", { name: "64k" }))
		expect(mocks.setModelTuning).toHaveBeenCalledWith(
			expect.objectContaining({ modelId: "pliny/auto-free", maxInputTokens: 64_000 }),
		)
	})

	it("clears the effort when thinking is switched off and keeps the context", () => {
		mocks.modelInfo = {
			contextWindow: 512_000,
			thinkingControls: { defaultOn: true, off: "template-kwargs", on: "reasoning-effort" },
		}
		mocks.modelTuning = { "snps-provider/GLM-5.2": { effort: "high", maxInputTokens: 64_000 } }
		open()
		fireEvent.click(screen.getByRole("radio", { name: "Off" }))
		expect(mocks.setModelTuning).toHaveBeenCalledWith(
			expect.objectContaining({ thinking: false, effort: undefined, maxInputTokens: 64_000 }),
		)
	})
})
