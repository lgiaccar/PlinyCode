import { describe, expect, it } from "vitest"
import { selectCandidates } from "./router-policy"
import { defaultRules } from "./router-rules"
import { applyRouterTuning, createTunedRules, routerBaseView } from "./router-tuning"
import type { RouterRequestFeatures, RouterRules } from "./router-types"

const KIMI = "snps-provider/kimi-k2.6"
const CODER = "snps-provider/qwen3-coder-480b-a35b-inst-fp8"
const GLM = "snps-provider/GLM-5.2"
const QWEN_397 = "snps-provider/qwen3.5-397b-fp8"
const SONNET_5 = "snps-aws-bedrock/global.anthropic.claude-sonnet-5"

const PROFILES = ["default", "fast", "smart", "balance"] as const

function route(rules: RouterRules, name: string) {
	return rules.routes.find((entry) => entry.name === name)
}

function features(overrides: Partial<RouterRequestFeatures> = {}): RouterRequestFeatures {
	return {
		mode: "act",
		prompt: "fix the failing test",
		estimatedTokens: 5_000,
		isSubAgent: false,
		hasImages: false,
		callIndex: 1,
		...overrides,
	}
}

describe("applyRouterTuning", () => {
	it("returns the rules unchanged without a tuning", () => {
		const rules = defaultRules()
		expect(applyRouterTuning(rules, undefined, "default")).toBe(rules)
	})

	it.each(PROFILES)("puts the model order on the %s profile's main routes and at the head of its pool", (profile) => {
		const base = defaultRules(profile)
		const rules = applyRouterTuning(base, { models: [GLM, KIMI] }, profile)
		for (const name of ["default", "coding", "plan-and-reasoning", "ask-reasoning"]) {
			if (route(base, name)) {
				expect(route(rules, name)?.use).toEqual([GLM, KIMI])
			}
		}
		expect(rules.pool.slice(0, 2)).toEqual([GLM, KIMI])
		expect(new Set(rules.pool).size).toBe(rules.pool.length)
		for (const name of ["subagent", "quick", "huge-context"]) {
			expect(route(rules, name)?.use).toEqual(route(base, name)?.use)
		}
	})

	it("makes FreeAuto start with GLM-5.2 when it heads the order", () => {
		const rules = applyRouterTuning(defaultRules(), { models: [GLM, KIMI, CODER] }, "default")
		const decision = selectCandidates({ rules, features: features(), isHealthy: () => true })
		expect(decision.routeName).toBe("coding")
		expect(decision.candidates[0]).toBe(GLM)
	})

	it("limits the pool to the order and the routes' own lists when exclusive", () => {
		const rules = applyRouterTuning(
			defaultRules(),
			{ models: [GLM, KIMI], exclusive: true, routes: { quick: { use: [CODER] } } },
			"default",
		)
		expect(rules.pool).toEqual([GLM, KIMI, CODER])
		// Nothing outside the list is ever a backup.
		const decision = selectCandidates({ rules, features: features(), isHealthy: () => true })
		expect(decision.candidates).toEqual([GLM, KIMI, CODER])
	})

	it("overrides one route's list, effort and bounds by name", () => {
		const rules = applyRouterTuning(
			defaultRules(),
			{
				models: [GLM],
				routes: {
					coding: { use: [QWEN_397, CODER], effort: "think", reasoningEffort: "high", maxEstimatedTokens: 50_000 },
					"huge-context": { minEstimatedTokens: 150_000 },
				},
			},
			"default",
		)
		expect(route(rules, "coding")).toMatchObject({
			use: [QWEN_397, CODER],
			effort: "think",
			reasoningEffort: "high",
			when: { mode: "act", maxEstimatedTokens: 50_000 },
		})
		// The other main routes still follow the order.
		expect(route(rules, "default")?.use).toEqual([GLM])
		expect(route(rules, "huge-context")?.when?.minEstimatedTokens).toBe(150_000)
	})

	it("clears a route's effort with 'default', so each model keeps its own", () => {
		const rules = applyRouterTuning(defaultRules(), { routes: { "plan-and-reasoning": { effort: "default" } } }, "default")
		expect(route(rules, "plan-and-reasoning")?.effort).toBeUndefined()
		expect(route(rules, "plan-and-reasoning")?.reasoningEffort).toBeUndefined()
	})

	it("drops paid models from a FreeAuto profile but keeps them on BalanceAuto", () => {
		const free = applyRouterTuning(defaultRules(), { models: [SONNET_5, KIMI], utility: { judge: SONNET_5 } }, "default")
		expect(route(free, "default")?.use).toEqual([KIMI])
		expect(free.pool).not.toContain(SONNET_5)
		expect(free.utility.judge).toBe(defaultRules().utility.judge)

		const balance = applyRouterTuning(defaultRules("balance"), { models: [KIMI, SONNET_5] }, "balance")
		expect(route(balance, "default")?.use).toEqual([KIMI, SONNET_5])
	})

	it("keeps the route's own list when every tuned model was dropped", () => {
		const rules = applyRouterTuning(defaultRules(), { models: [SONNET_5] }, "default")
		expect(route(rules, "default")?.use).toEqual(route(defaultRules(), "default")?.use)
	})

	it("replaces only the scalars it sets", () => {
		const base = defaultRules("smart")
		const rules = applyRouterTuning(
			base,
			{
				classifier: { enabled: false },
				health: { stallTimeoutMs: 30_000 },
				escalation: { maxNudgesPerRun: 0 },
				sticky: false,
				contextMarginRatio: 1.3,
			},
			"smart",
		)
		expect(rules.classifier).toEqual({ ...base.classifier, enabled: false })
		expect(rules.health).toEqual({ ...base.health, stallTimeoutMs: 30_000 })
		expect(rules.escalation).toEqual({ ...base.escalation, maxNudgesPerRun: 0 })
		expect(rules.sticky).toBe(false)
		expect(rules.contextMarginRatio).toBe(1.3)
		expect(rules.routes).toEqual(base.routes)
	})

	it("moves an unset judge along with a changed classifier model", () => {
		const rules = applyRouterTuning(defaultRules(), { utility: { classifier: CODER } }, "default")
		expect(rules.utility.classifier).toBe(CODER)
		expect(rules.utility.judge).toBe(CODER)
	})
})

describe("createTunedRules", () => {
	it("reuses the result while the rules and the stored tuning are the same objects", () => {
		const tuned = createTunedRules()
		const rules = defaultRules()
		const tuning = { models: [GLM] }
		const first = tuned(rules, tuning, "default")
		expect(tuned(rules, tuning, "default")).toBe(first)
		expect(tuned(rules, { models: [KIMI] }, "default")).not.toBe(first)
	})

	it("ignores invalid stored values", () => {
		const tuned = createTunedRules()
		const rules = defaultRules()
		expect(tuned(rules, { models: "glm", health: { stallTimeoutMs: -5 } }, "default")).toEqual(rules)
	})
})

describe("routerBaseView", () => {
	it("shows the catch-all route's list as the default order", () => {
		const view = routerBaseView(defaultRules())
		expect(view.models).toEqual(route(defaultRules(), "default")?.use)
		expect(view.routes.find((entry) => entry.name === "huge-context")).toMatchObject({ minEstimatedTokens: 180_000 })
		expect(view.escalation.maxNudgesPerRun).toBe(8)
	})
})
