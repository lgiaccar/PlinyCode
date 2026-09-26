import { OpenRouterModelInfo } from "@shared/proto/cline/models"
import { describe, expect, it } from "vitest"
import { fromProtobufModelInfo, toProtobufModelInfo } from "./typeConversion"

describe("model info proto conversion", () => {
	it("round-trips parameter counts and pricing details through the wire format", () => {
		const wire = OpenRouterModelInfo.decode(
			OpenRouterModelInfo.encode(
				toProtobufModelInfo({
					name: "Kimi K2.6",
					supportsPromptCache: false,
					inputPrice: 0,
					outputPrice: 0,
					parameters: { totalB: 1000, activeB: 32 },
					pricingUnavailable: true,
					pricingNote: "Price not listed on the Pliny catalog",
				}),
			).finish(),
		)
		const info = fromProtobufModelInfo(wire)

		expect(info.parameters?.totalB).toBe(1000)
		expect(info.parameters?.activeB).toBe(32)
		expect(info.pricingUnavailable).toBe(true)
		expect(info.pricingNote).toBe("Price not listed on the Pliny catalog")
	})

	it("leaves the details undefined for a model without them", () => {
		const info = fromProtobufModelInfo(toProtobufModelInfo({ name: "m", supportsPromptCache: false }))
		expect(info.parameters).toBeUndefined()
		expect(info.pricingUnavailable).toBeUndefined()
		expect(info.pricingNote).toBeUndefined()
	})
})
