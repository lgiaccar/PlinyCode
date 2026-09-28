import type { ProviderListing } from "@shared/proto/cline/models"
import { describe, expect, it } from "vitest"
import {
	getFallbackGenericProviderSettings,
	getGenericProviderSettings,
	isGenericProviderListing,
} from "./providerSettingsRegistry"

function listing(overrides: Partial<ProviderListing>): ProviderListing {
	return {
		allowsCustomModelIds: false,
		id: "pliny",
		name: "Pliny",
		protocol: "openai-chat",
		...overrides,
	} as ProviderListing
}

describe("providerSettingsRegistry", () => {
	it("builds the Pliny settings from the SDK provider listing", () => {
		expect(getGenericProviderSettings("pliny", listing({ name: "Pliny Gateway" }))).toEqual({
			allowsCustomIds: false,
			providerId: "pliny",
			providerName: "Pliny Gateway",
		})
	})

	it("ignores a listing for another provider", () => {
		expect(getGenericProviderSettings("pliny", listing({ id: "deepseek", name: "DeepSeek" }))).toBeUndefined()
	})

	it("ignores a listing without a name or with an unknown protocol", () => {
		expect(isGenericProviderListing(listing({ name: "" }))).toBe(false)
		expect(isGenericProviderListing(listing({ protocol: "carrier-pigeon" }))).toBe(false)
		expect(isGenericProviderListing(undefined)).toBe(false)
	})

	it("falls back to the Pliny settings before the listing arrives", () => {
		expect(getFallbackGenericProviderSettings("pliny")).toEqual({
			allowsCustomIds: false,
			providerId: "pliny",
			providerName: "Pliny",
		})
		expect(getFallbackGenericProviderSettings("deepseek")).toBeUndefined()
	})
})
