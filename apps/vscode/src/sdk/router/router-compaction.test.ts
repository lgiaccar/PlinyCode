import { PLINY_BALANCE_AUTO_MODEL_ID, PLINY_FREE_AUTO_MODEL_ID, plinyFreeAutoModelId } from "@plinycode/llms"
import { describe, expect, it } from "vitest"
import { routerCompactionOverrides } from "./router-compaction"

describe("routerCompactionOverrides", () => {
	it("gives a concrete model no overrides", () => {
		expect(routerCompactionOverrides("snps-provider/kimi-k2.6", () => ({}))).toEqual({})
	})

	it("leaves an untuned router on its compiled budget and the adaptive target", () => {
		const overrides = routerCompactionOverrides(PLINY_FREE_AUTO_MODEL_ID, () => undefined)
		expect(typeof overrides.maxInputTokensOverride).toBe("function")
		expect((overrides.maxInputTokensOverride as () => number | undefined)()).toBeUndefined()
		expect((overrides.targetTokensOverride as () => number | undefined)()).toBeUndefined()
	})

	it("reads the profile's tuning on every call and resolves it to tokens", () => {
		let tuning: unknown = { smart: { compaction: { budget: { unit: "percent", value: 50 } } } }
		const overrides = routerCompactionOverrides(plinyFreeAutoModelId("smart"), () => tuning)
		const budget = overrides.maxInputTokensOverride as () => number | undefined
		const target = overrides.targetTokensOverride as () => number | undefined
		// Half of smart's compiled 300k.
		expect(budget()).toBe(150_000)
		tuning = {
			smart: { compaction: { budget: { unit: "tokens", value: 400_000 }, target: { unit: "percent", value: 25 } } },
		}
		expect(budget()).toBe(400_000)
		expect(target()).toBe(100_000)
		// Another profile's tuning does not apply.
		tuning = { default: { compaction: { budget: { unit: "tokens", value: 90_000 } } } }
		expect(budget()).toBeUndefined()
	})

	it("lets a model tuning's smaller context win over a raised budget", () => {
		const overrides = routerCompactionOverrides(
			PLINY_BALANCE_AUTO_MODEL_ID,
			() => ({ balance: { compaction: { budget: { unit: "tokens", value: 500_000 } } } }),
			{ maxInputTokens: 128_000 },
		)
		expect((overrides.maxInputTokensOverride as () => number | undefined)()).toBe(128_000)
	})
})
