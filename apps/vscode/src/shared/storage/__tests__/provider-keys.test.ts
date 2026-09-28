import { describe, it } from "bun:test"
import { getProviderCollectionSync } from "@plinycode/llms"
import { expect } from "chai"
import { getProviderDefaultModelId, getProviderModelIdKey } from "../provider-keys"

describe("Provider key mapping", () => {
	it("returns the SDK-declared default for Pliny", () => {
		const expectedDefault = getProviderCollectionSync("pliny")?.provider.defaultModelId ?? ""
		expect(getProviderDefaultModelId("pliny")).to.equal(expectedDefault)
	})

	it("returns an empty string for a provider the SDK doesn't know", () => {
		expect(getProviderDefaultModelId("not-a-provider")).to.equal("")
	})

	it("uses the generic model key for Pliny", () => {
		expect(getProviderModelIdKey("pliny", "act")).to.equal("actModeApiModelId")
		expect(getProviderModelIdKey("pliny", "plan")).to.equal("planModeApiModelId")
	})

	it("uses the generic model key for a removed provider", () => {
		expect(getProviderModelIdKey("openrouter", "act")).to.equal("actModeApiModelId")
	})

	it("uses provider-specific model keys for Cline and ClinePass", () => {
		expect(getProviderModelIdKey("cline", "act")).to.equal("actModeClineModelId")
		expect(getProviderModelIdKey("cline-pass", "plan")).to.equal("planModeClinePassModelId")
	})
})
