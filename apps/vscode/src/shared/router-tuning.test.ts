import { describe, expect, it } from "vitest"
import { normalizeRouterProfileTuning, normalizeRouterTuning, ROUTER_TUNING_MAX_MODELS } from "./router-tuning"

describe("normalizeRouterTuning", () => {
	it("keeps the known profiles and drops the rest", () => {
		expect(normalizeRouterTuning({ default: { sticky: false }, turbo: { sticky: false }, balance: {} })).toEqual({
			default: { sticky: false },
		})
		expect(normalizeRouterTuning("nonsense")).toEqual({})
	})

	it("dedupes the model order and caps it", () => {
		const ids = Array.from({ length: 10 }, (_, index) => `snps-provider/m${index}`)
		const tuning = normalizeRouterProfileTuning({ models: [" a ", "a", "", 3, ...ids] })
		expect(tuning?.models?.[0]).toBe("a")
		expect(tuning?.models).toHaveLength(ROUTER_TUNING_MAX_MODELS)
	})

	it("drops invalid numbers, keeps zero reminders and rounds to whole numbers", () => {
		expect(
			normalizeRouterProfileTuning({
				health: { stallTimeoutMs: -1, firstTokenTimeoutMs: 30_000.4, cooldownMs: "10" },
				escalation: { maxNudgesPerRun: 0, afterStalls: 0 },
				contextMarginRatio: 0.9,
			}),
		).toEqual({ health: { firstTokenTimeoutMs: 30_000 }, escalation: { maxNudgesPerRun: 0 } })
	})

	it("keeps route overrides with valid names and fields only", () => {
		expect(
			normalizeRouterProfileTuning({
				routes: {
					coding: { use: ["x"], effort: "think", reasoningEffort: "extreme", maxEstimatedTokens: 50_000 },
					"bad name!": { use: ["x"] },
					quick: { effort: "sometimes" },
				},
			}),
		).toEqual({ routes: { coding: { use: ["x"], effort: "think", maxEstimatedTokens: 50_000 } } })
	})

	it("drops exclusive without a model order, and an entry with nothing left", () => {
		expect(normalizeRouterProfileTuning({ exclusive: true })).toBeUndefined()
		expect(normalizeRouterProfileTuning({ exclusive: true, models: ["a"] })).toEqual({ exclusive: true, models: ["a"] })
	})
})
