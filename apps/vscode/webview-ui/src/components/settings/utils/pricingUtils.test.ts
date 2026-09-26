import type { ModelInfo } from "@shared/api"
import { describe, expect, it } from "vitest"
import {
	formatCompactContext,
	formatCompactPrice,
	formatParamCount,
	formatParameters,
	formatPricePerMillion,
	formatRowPrice,
} from "./pricingUtils"

const info = (overrides: Partial<ModelInfo>): ModelInfo => ({ supportsPromptCache: false, ...overrides })

describe("formatCompactPrice / formatCompactContext", () => {
	it("formats prices and token counts compactly", () => {
		expect(formatCompactPrice(0)).toBe("Free")
		expect(formatCompactPrice(3)).toBe("$3/M")
		expect(formatCompactPrice(undefined)).toBe("N/A")
		expect(formatCompactContext(200_000)).toBe("200K")
		expect(formatCompactContext(1_000_000)).toBe("1M")
		expect(formatCompactContext(1_048_576)).toBe("1.0M")
	})
})

describe("formatPricePerMillion", () => {
	it("keeps three decimals and says Free for zero", () => {
		expect(formatPricePerMillion(0.175)).toBe("$0.175 / 1M tokens")
		expect(formatPricePerMillion(3)).toBe("$3.00 / 1M tokens")
		expect(formatPricePerMillion(0)).toBe("Free")
		expect(formatPricePerMillion(undefined)).toBe("—")
	})
})

describe("formatRowPrice", () => {
	it("shows input/output, Free, or the unknown label", () => {
		expect(formatRowPrice(info({ inputPrice: 3, outputPrice: 15 }))).toBe("$3/$15")
		expect(formatRowPrice(info({ inputPrice: 1.75, outputPrice: 14 }))).toBe("$1.75/$14")
		expect(formatRowPrice(info({ inputPrice: 0, outputPrice: 0 }))).toBe("Free")
		// Unknown prices arrive as 0 for cost accounting; they must not read as free.
		expect(formatRowPrice(info({ inputPrice: 0, outputPrice: 0, pricingUnavailable: true }))).toBe("price ?")
		expect(formatRowPrice(info({ pricingUnavailable: true }), "varies")).toBe("varies")
	})
})

describe("formatParameters", () => {
	it("describes mixture-of-experts and dense models", () => {
		expect(formatParamCount(1000)).toBe("1T")
		expect(formatParamCount(30.7)).toBe("30.7B")
		expect(formatParameters(info({ parameters: { totalB: 1000, activeB: 32 } }))).toBe("1T total · 32B active per token")
		expect(formatParameters(info({ parameters: { totalB: 70, activeB: 70 } }))).toBe("70B (dense)")
		expect(formatParameters(info({}))).toBeUndefined()
	})
})
