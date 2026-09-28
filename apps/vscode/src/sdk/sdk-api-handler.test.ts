import type { ApiConfiguration } from "@shared/api"
import { PLINY_FREE_AUTO_FALLBACK_MODEL_ID, PLINY_FREE_AUTO_MODEL_ID } from "@shared/pliny"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PLINY_REQUEST_TIMEOUT_MS } from "./pliny-fetch"
import { buildSdkProviderConfig } from "./sdk-api-handler"

const mocks = vi.hoisted(() => {
	const providerSettingsManager = {
		getProviderSettings: vi.fn(),
	}
	return {
		getProviderSettingsManager: vi.fn(() => providerSettingsManager),
		providerSettingsManager,
	}
})

vi.mock("./provider-migration", () => ({
	getProviderSettingsManager: mocks.getProviderSettingsManager,
}))

vi.mock("@shared/services/Logger", () => ({
	Logger: {
		warn: vi.fn(),
	},
}))

function mockPlinySettings(settings: Record<string, unknown>): void {
	mocks.providerSettingsManager.getProviderSettings.mockImplementation((providerId: string) =>
		providerId === "pliny" ? { provider: "pliny", ...settings } : undefined,
	)
}

describe("buildSdkProviderConfig", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("reads the Pliny API key and base URL from providers.json", () => {
		mockPlinySettings({ apiKey: "pliny-key", baseUrl: "https://pliny.example/v1" })

		const providerConfig = buildSdkProviderConfig(
			{ actModeApiProvider: "pliny", actModeApiModelId: "snps-provider/GLM-5.2" },
			"act",
		)

		expect(providerConfig).toMatchObject({
			providerId: "pliny",
			modelId: "snps-provider/GLM-5.2",
			apiKey: "pliny-key",
			baseUrl: "https://pliny.example/v1",
			timeoutMs: PLINY_REQUEST_TIMEOUT_MS,
		})
		expect(mocks.providerSettingsManager.getProviderSettings).toHaveBeenCalledWith("pliny")
	})

	it("maps the FreeAuto router onto a concrete model for standalone handlers", () => {
		mockPlinySettings({ apiKey: "pliny-key" })

		const providerConfig = buildSdkProviderConfig(
			{ planModeApiProvider: "pliny", planModeApiModelId: PLINY_FREE_AUTO_MODEL_ID },
			"plan",
		)

		expect(providerConfig.modelId).toBe(PLINY_FREE_AUTO_FALLBACK_MODEL_ID)
	})

	it("runs on Pliny when an older version stored another provider", () => {
		mockPlinySettings({ apiKey: "pliny-key" })

		const providerConfig = buildSdkProviderConfig(
			{
				actModeApiProvider: "openrouter",
				actModeApiModelId: "snps-provider/kimi-k2.6",
			} as unknown as ApiConfiguration,
			"act",
		)

		expect(providerConfig).toMatchObject({
			providerId: "pliny",
			modelId: "snps-provider/kimi-k2.6",
			apiKey: "pliny-key",
		})
	})

	it("turns reasoning off when asked to", () => {
		mockPlinySettings({ apiKey: "pliny-key" })

		const providerConfig = buildSdkProviderConfig(
			{ actModeApiProvider: "pliny", actModeApiModelId: "snps-provider/kimi-k2.6", actModeReasoningEffort: "high" },
			"act",
			{ disableReasoning: true },
		)

		expect(providerConfig.thinking).toBe(false)
		expect(providerConfig).not.toHaveProperty("reasoningEffort")
	})
})
