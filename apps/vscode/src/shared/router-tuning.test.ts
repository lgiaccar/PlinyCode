import { describe, expect, it } from "vitest"
import {
	compactionSizeTokens,
	normalizeRouterProfileTuning,
	normalizeRouterTuning,
	ROUTER_TUNING_MAX_MODELS,
	resolveRouterCompaction,
	routerTuningProfileFor,
	withRouterCompactionBudget,
} from "./router-tuning"

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

describe("router compaction tuning", () => {
	it("keeps a budget and a target with a unit and a positive value, and drops the rest", () => {
		expect(
			normalizeRouterProfileTuning({
				compaction: { budget: { unit: "tokens", value: 250_000.4 }, target: { unit: "percent", value: 40.25 } },
			}),
		).toEqual({ compaction: { budget: { unit: "tokens", value: 250_000 }, target: { unit: "percent", value: 40.3 } } })
		expect(normalizeRouterProfileTuning({ compaction: { budget: { unit: "lines", value: 5 } } })).toBeUndefined()
		expect(normalizeRouterProfileTuning({ compaction: { budget: { unit: "tokens", value: -1 } } })).toBeUndefined()
		expect(normalizeRouterProfileTuning({ compaction: { target: { value: 1000 } } })).toBeUndefined()
	})

	it("resolves percentages against the compiled budget, and the target against the tuned one", () => {
		expect(resolveRouterCompaction(undefined, 200_000)).toEqual({})
		expect(resolveRouterCompaction({ budget: { unit: "percent", value: 125 } }, 200_000)).toEqual({ budgetTokens: 250_000 })
		expect(
			resolveRouterCompaction(
				{ budget: { unit: "tokens", value: 300_000 }, target: { unit: "percent", value: 50 } },
				200_000,
			),
		).toEqual({ budgetTokens: 300_000, targetTokens: 150_000 })
		// Without a tuned budget the target is a share of the compiled one.
		expect(resolveRouterCompaction({ target: { unit: "percent", value: 40 } }, 200_000)).toEqual({ targetTokens: 80_000 })
		expect(resolveRouterCompaction({ target: { unit: "tokens", value: 90_000 } }, 200_000)).toEqual({ targetTokens: 90_000 })
	})

	it("converts one size to tokens", () => {
		expect(compactionSizeTokens(undefined, 100)).toBeUndefined()
		expect(compactionSizeTokens({ unit: "percent", value: 50 }, 1_000)).toBe(500)
		expect(compactionSizeTokens({ unit: "tokens", value: 1_234 }, 1_000)).toBe(1_234)
	})
})

describe("router compaction budget in the context bar", () => {
	it("maps router ids, old and new, onto their profiles", () => {
		expect(routerTuningProfileFor("pliny/auto-free")).toBe("default")
		expect(routerTuningProfileFor("pliny/auto-free-smart")).toBe("smart")
		expect(routerTuningProfileFor("pliny/free-auto-fast")).toBe("fast")
		expect(routerTuningProfileFor("pliny/balance-auto")).toBe("balance")
		expect(routerTuningProfileFor("pliny/auto-free-turbo")).toBeUndefined()
		expect(routerTuningProfileFor("snps-provider/kimi-k2.6")).toBeUndefined()
	})

	it("puts a router's tuned budget in maxInputTokens and leaves everything else alone", () => {
		const info = { contextWindow: 512_000, maxInputTokens: 200_000 }
		const tuning = { default: { compaction: { budget: { unit: "percent", value: 150 } } } }
		expect(withRouterCompactionBudget(info, "pliny/auto-free", tuning)).toEqual({
			contextWindow: 512_000,
			maxInputTokens: 300_000,
		})
		expect(withRouterCompactionBudget(info, "pliny/auto-free-smart", tuning)).toBe(info)
		expect(withRouterCompactionBudget(info, "snps-provider/kimi-k2.6", tuning)).toBe(info)
		expect(withRouterCompactionBudget(undefined, "pliny/auto-free", tuning)).toBeUndefined()
	})
})
