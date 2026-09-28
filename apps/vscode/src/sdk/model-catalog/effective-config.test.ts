import { beforeEach, describe, expect, it, vi } from "vitest"
import { parseProviderId } from "./provider-id"

const mocks = vi.hoisted(() => {
	let providerSettingsById: Record<string, unknown> = {}

	return {
		setProviderSettings(value: Record<string, unknown>): void {
			providerSettingsById = value
		},
		getProviderSettingsManager() {
			return { getProviderSettings: (providerId: string) => providerSettingsById[providerId] }
		},
	}
})

vi.mock("../provider-migration", () => ({
	getProviderSettingsManager: mocks.getProviderSettingsManager,
}))

describe("buildEffectiveProviderConfig", () => {
	beforeEach(() => {
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

	it("drops fields providers.json doesn't set", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({ pliny: { provider: "pliny", apiKey: "pliny-key", baseUrl: "" } })

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
})
