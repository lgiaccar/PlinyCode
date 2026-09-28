import { ApiFormat, ResolveModelInfoResponse } from "@shared/proto/cline/models"
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import { useNormalizedApiConfiguration } from "./useNormalizedApiConfiguration"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		resolveModelInfo: vi.fn(),
		resolveProviderModels: vi.fn(),
	},
}))

const mockUseExtensionState = vi.mocked(useExtensionState)
const mockResolveModelInfo = vi.mocked(ModelsServiceClient.resolveModelInfo)
const mockResolveProviderModels = vi.mocked(ModelsServiceClient.resolveProviderModels)

function setApiConfiguration(apiConfiguration: Record<string, unknown>) {
	mockUseExtensionState.mockReturnValue({ apiConfiguration } as ReturnType<typeof useExtensionState>)
}

function modelInfoResponse(modelId: string, contextWindow = 262_144) {
	return ResolveModelInfoResponse.create({
		providerId: "pliny",
		modelId,
		source: "sdk-known-models",
		modelInfo: {
			name: "Kimi K2.6",
			contextWindow,
			maxTokens: 32_768,
			supportsPromptCache: true,
			supportsReasoning: true,
			apiFormat: ApiFormat.OPENAI_CHAT,
		},
	})
}

describe("useNormalizedApiConfiguration", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		setApiConfiguration({})
	})

	it("resolves Pliny model info through the pure RPC", async () => {
		setApiConfiguration({ actModeApiProvider: "pliny", actModeApiModelId: "snps-provider/kimi-k2.6" })
		mockResolveModelInfo.mockResolvedValue(modelInfoResponse("snps-provider/kimi-k2.6"))

		const { result } = renderHook(() => useNormalizedApiConfiguration("act"))

		expect(result.current.selectedModelInfo.contextWindow).toBeUndefined()
		await waitFor(() => expect(result.current.selectedModelInfo.contextWindow).toBe(262_144))
		expect(result.current.selectedProvider).toBe("pliny")
		expect(result.current.selectedModelId).toBe("snps-provider/kimi-k2.6")
		expect(mockResolveModelInfo).toHaveBeenCalledWith({ providerId: "pliny", modelId: "snps-provider/kimi-k2.6" })
		expect(mockResolveProviderModels).not.toHaveBeenCalled()
	})

	it("does not flash a context window before the RPC resolves", () => {
		setApiConfiguration({ actModeApiProvider: "pliny", actModeApiModelId: "snps-provider/kimi-k2.6" })
		mockResolveModelInfo.mockReturnValue(new Promise(() => undefined))

		const { result } = renderHook(() => useNormalizedApiConfiguration("act"))

		expect(result.current.selectedModelInfo.contextWindow).toBeUndefined()
		expect(mockResolveProviderModels).not.toHaveBeenCalled()
	})

	it("uses the SDK default model info when model id is empty", async () => {
		setApiConfiguration({ actModeApiProvider: "pliny", actModeApiModelId: "" })
		mockResolveModelInfo.mockResolvedValue(modelInfoResponse("pliny/auto-free"))

		const { result } = renderHook(() => useNormalizedApiConfiguration("act"))

		await waitFor(() => expect(result.current.selectedModelId).toBe("pliny/auto-free"))
		expect(mockResolveModelInfo).toHaveBeenCalledWith({ providerId: "pliny", modelId: undefined })
	})

	it("reads a provider stored by an older version as Pliny and uses the generic model field", async () => {
		setApiConfiguration({
			actModeApiProvider: "openrouter",
			actModeApiModelId: "snps-provider/GLM-5.2",
			actModeOpenRouterModelId: "anthropic/claude-sonnet-4.5",
		})
		mockResolveModelInfo.mockResolvedValue(modelInfoResponse("snps-provider/GLM-5.2"))

		const { result } = renderHook(() => useNormalizedApiConfiguration("act"))

		await waitFor(() => expect(result.current.selectedModelId).toBe("snps-provider/GLM-5.2"))
		expect(result.current.selectedProvider).toBe("pliny")
		expect(mockResolveModelInfo).toHaveBeenCalledWith({ providerId: "pliny", modelId: "snps-provider/GLM-5.2" })
	})

	it("ignores stale responses after the model changes", async () => {
		let resolveFirst: (value: ResolveModelInfoResponse) => void = () => undefined
		mockResolveModelInfo
			.mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
			.mockResolvedValueOnce(modelInfoResponse("snps-provider/GLM-5.2", 512_000))
		setApiConfiguration({ actModeApiProvider: "pliny", actModeApiModelId: "snps-provider/kimi-k2.6" })

		const { result, rerender } = renderHook(() => useNormalizedApiConfiguration("act"))

		setApiConfiguration({ actModeApiProvider: "pliny", actModeApiModelId: "snps-provider/GLM-5.2" })
		rerender()
		await act(async () => {
			resolveFirst(modelInfoResponse("snps-provider/kimi-k2.6", 262_144))
		})

		await waitFor(() => expect(result.current.selectedModelId).toBe("snps-provider/GLM-5.2"))
		expect(result.current.selectedModelInfo.contextWindow).toBe(512_000)
	})
})
