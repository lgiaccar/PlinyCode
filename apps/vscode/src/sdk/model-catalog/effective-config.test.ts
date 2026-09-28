import type { ApiConfiguration } from "@shared/api"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { parseProviderId } from "./provider-id"

const mocks = vi.hoisted(() => {
	let apiConfiguration: ApiConfiguration = {}
	let providerSettingsById: Record<string, unknown> = {}

	return {
		setApiConfiguration(value: ApiConfiguration): void {
			apiConfiguration = value
		},
		setProviderSettings(value: Record<string, unknown>): void {
			providerSettingsById = value
		},
		getStateManager() {
			return { getApiConfiguration: () => apiConfiguration }
		},
		getProviderSettingsManager() {
			return { getProviderSettings: (providerId: string) => providerSettingsById[providerId] }
		},
	}
})

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: { get: mocks.getStateManager },
}))

vi.mock("../provider-migration", () => ({
	getProviderSettingsManager: mocks.getProviderSettingsManager,
}))

describe("buildEffectiveProviderConfig", () => {
	beforeEach(() => {
		mocks.setApiConfiguration({})
		mocks.setProviderSettings({})
	})

	it("builds the Pliny config from providers.json", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			pliny: {
				provider: "pliny",
				apiKey: "pliny-key",
				baseUrl: "https://pliny.example/v1",
				headers: { "x-team": "eda" },
				contextWindow: 65536,
				extras: { providerOnly: true },
			},
		})

		expect(buildEffectiveProviderConfig(parseProviderId("pliny"))).toEqual({
			providerId: parseProviderId("pliny"),
			apiKey: "pliny-key",
			baseUrl: "https://pliny.example/v1",
			headers: { "x-team": "eda" },
			contextWindow: 65536,
			extras: { providerOnly: true },
		})
	})

	it("does not overlay StateManager fields onto the Pliny config", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({ pliny: { provider: "pliny", apiKey: "pliny-key" } })
		mocks.setApiConfiguration({ clineApiKey: "cline-access-token", ocaBaseUrl: "https://oca.example" })

		expect(buildEffectiveProviderConfig(parseProviderId("pliny"))).toEqual({
			providerId: parseProviderId("pliny"),
			apiKey: "pliny-key",
		})
	})

	it("returns only the provider id when providers.json has no entry", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")

		expect(buildEffectiveProviderConfig(parseProviderId("pliny"))).toEqual({
			providerId: parseProviderId("pliny"),
		})
	})

	it("keeps Cline account auth in the auth envelope", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setApiConfiguration({ clineApiKey: "cline-access-token", clineAccountId: "account-123" })

		expect(buildEffectiveProviderConfig(parseProviderId("cline"))).toEqual({
			providerId: parseProviderId("cline"),
			apiKey: "cline-access-token",
			auth: { accessToken: "cline-access-token", accountId: "account-123" },
		})
	})
})
