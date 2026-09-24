import { describe, expect, it } from "vitest"
import { fitsContext, routeMatches, selectCandidates, selectRoute } from "./router-policy"
import { defaultRules } from "./router-rules"
import type { RouterRequestFeatures, RouterRules } from "./router-types"

function features(overrides: Partial<RouterRequestFeatures> = {}): RouterRequestFeatures {
	return {
		estimatedTokens: 1_000,
		mode: "act",
		prompt: "hello",
		hasImages: false,
		isSubAgent: false,
		callIndex: 1,
		...overrides,
	}
}

function rules(overrides: Partial<RouterRules> = {}): RouterRules {
	return { ...defaultRules(), ...overrides }
}

const alwaysHealthy = () => true

describe("routeMatches", () => {
	it("matches a route with no conditions", () => {
		expect(routeMatches({ name: "any", use: ["snps-provider/a"] }, features())).toBe(true)
	})

	it("respects mode", () => {
		const route = { name: "plan-only", when: { mode: "plan" as const }, use: ["snps-provider/a"] }
		expect(routeMatches(route, features({ mode: "plan" }))).toBe(true)
		expect(routeMatches(route, features({ mode: "act" }))).toBe(false)
	})

	it("respects token bounds", () => {
		const route = {
			name: "mid",
			when: { minEstimatedTokens: 100, maxEstimatedTokens: 200 },
			use: ["snps-provider/a"],
		}
		expect(routeMatches(route, features({ estimatedTokens: 150 }))).toBe(true)
		expect(routeMatches(route, features({ estimatedTokens: 99 }))).toBe(false)
		expect(routeMatches(route, features({ estimatedTokens: 201 }))).toBe(false)
	})

	it("respects prompt length and pattern", () => {
		const route = {
			name: "short-question",
			when: { maxPromptChars: 10, promptRegex: "^what\\b" },
			use: ["snps-provider/a"],
		}
		expect(routeMatches(route, features({ prompt: "what is x" }))).toBe(true)
		expect(routeMatches(route, features({ prompt: "why is x" }))).toBe(false)
		expect(routeMatches(route, features({ prompt: "what is a very long question" }))).toBe(false)
	})

	it("matches the prompt pattern case-insensitively", () => {
		const route = { name: "fix", when: { promptRegex: "\\bfix\\b" }, use: ["snps-provider/a"] }
		expect(routeMatches(route, features({ prompt: "Please FIX the bug" }))).toBe(true)
	})

	it("treats an uncompilable pattern as non-matching rather than throwing", () => {
		const route = { name: "bad", when: { promptRegex: "([unclosed" }, use: ["snps-provider/a"] }
		expect(() => routeMatches(route, features())).not.toThrow()
		expect(routeMatches(route, features())).toBe(false)
	})

	it("respects the subAgent condition in both directions", () => {
		const subOnly = { name: "sub", when: { subAgent: true }, use: ["snps-provider/a"] }
		const mainOnly = { name: "main", when: { subAgent: false }, use: ["snps-provider/a"] }
		expect(routeMatches(subOnly, features({ isSubAgent: true }))).toBe(true)
		expect(routeMatches(subOnly, features({ isSubAgent: false }))).toBe(false)
		expect(routeMatches(mainOnly, features({ isSubAgent: true }))).toBe(false)
		expect(routeMatches(mainOnly, features({ isSubAgent: false }))).toBe(true)
	})
})

describe("selectRoute", () => {
	it("returns the first matching route", () => {
		const configured = rules({
			routes: [
				{ name: "never", when: { minEstimatedTokens: 999_999 }, use: ["snps-provider/a"] },
				{ name: "always", use: ["snps-provider/b"] },
			],
		})
		expect(selectRoute(configured, features())?.name).toBe("always")
	})

	it("returns undefined when nothing matches", () => {
		const configured = rules({
			routes: [{ name: "never", when: { minEstimatedTokens: 999_999 }, use: ["snps-provider/a"] }],
		})
		expect(selectRoute(configured, features())).toBeUndefined()
	})
})

describe("fitsContext", () => {
	const known = {
		"snps-provider/small": { id: "snps-provider/small", name: "small", contextWindow: 1_000 },
		"snps-provider/big": { id: "snps-provider/big", name: "big", contextWindow: 500_000 },
	} as never

	it("rejects a model whose window cannot hold the request plus margin", () => {
		const configured = rules({ contextMarginRatio: 1.15 })
		expect(fitsContext("snps-provider/small", features({ estimatedTokens: 900 }), configured, known)).toBe(false)
		expect(fitsContext("snps-provider/big", features({ estimatedTokens: 900 }), configured, known)).toBe(true)
	})

	it("allows a model with unknown metadata rather than shrinking the pool", () => {
		expect(fitsContext("snps-provider/unlisted", features(), rules(), known)).toBe(true)
		expect(fitsContext("snps-provider/unlisted", features(), rules(), undefined)).toBe(true)
	})
})

describe("selectCandidates", () => {
	const pool = ["snps-provider/a", "snps-provider/b", "snps-provider/c"]

	it("puts the matching route's models first, then the rest of the pool", () => {
		const configured = rules({
			pool,
			routes: [{ name: "coding", use: ["snps-provider/c"] }],
		})
		const decision = selectCandidates({
			rules: configured,
			features: features(),
			isHealthy: alwaysHealthy,
		})
		expect(decision.routeName).toBe("coding")
		expect(decision.candidates).toEqual(["snps-provider/c", "snps-provider/a", "snps-provider/b"])
	})

	it("drops candidates that are not in the pool", () => {
		const configured = rules({
			pool: ["snps-provider/a"],
			routes: [{ name: "r", use: ["snps-provider/not-in-pool", "snps-provider/a"] }],
		})
		const decision = selectCandidates({
			rules: configured,
			features: features(),
			isHealthy: alwaysHealthy,
		})
		expect(decision.candidates).toEqual(["snps-provider/a"])
	})

	it("skips benched models and reports them", () => {
		const configured = rules({ pool, routes: [{ name: "r", use: pool }] })
		const decision = selectCandidates({
			rules: configured,
			features: features(),
			isHealthy: (id) => id !== "snps-provider/a",
		})
		expect(decision.candidates).toEqual(["snps-provider/b", "snps-provider/c"])
		expect(decision.excludedUnhealthy).toEqual(["snps-provider/a"])
	})

	it("skips models whose context window is too small and reports them", () => {
		const known = {
			"snps-provider/a": { id: "snps-provider/a", name: "a", contextWindow: 1_000 },
			"snps-provider/b": { id: "snps-provider/b", name: "b", contextWindow: 500_000 },
		} as never
		const configured = rules({ pool: ["snps-provider/a", "snps-provider/b"], routes: [{ name: "r", use: [] }] })
		const decision = selectCandidates({
			rules: { ...configured, routes: [{ name: "r", use: ["snps-provider/a", "snps-provider/b"] }] },
			features: features({ estimatedTokens: 100_000 }),
			knownModels: known,
			isHealthy: alwaysHealthy,
		})
		expect(decision.candidates).toEqual(["snps-provider/b"])
		expect(decision.excludedTooSmall).toEqual(["snps-provider/a"])
	})

	it("promotes the sticky model when it is still viable", () => {
		const configured = rules({ pool, routes: [{ name: "r", use: ["snps-provider/a"] }], sticky: true })
		const decision = selectCandidates({
			rules: configured,
			features: features({ stickyModelId: "snps-provider/c" }),
			isHealthy: alwaysHealthy,
		})
		expect(decision.candidates[0]).toBe("snps-provider/c")
	})

	it("ignores the sticky model when sticky routing is off", () => {
		const configured = rules({ pool, routes: [{ name: "r", use: ["snps-provider/a"] }], sticky: false })
		const decision = selectCandidates({
			rules: configured,
			features: features({ stickyModelId: "snps-provider/c" }),
			isHealthy: alwaysHealthy,
		})
		expect(decision.candidates[0]).toBe("snps-provider/a")
	})

	it("relaxes the size filter before giving up", () => {
		const known = {
			"snps-provider/a": { id: "snps-provider/a", name: "a", contextWindow: 1_000 },
		} as never
		const configured = rules({ pool: ["snps-provider/a"], routes: [{ name: "r", use: ["snps-provider/a"] }] })
		const decision = selectCandidates({
			rules: configured,
			features: features({ estimatedTokens: 999_999 }),
			knownModels: known,
			isHealthy: alwaysHealthy,
		})
		// Nothing fits, but refusing to call at all would be worse.
		expect(decision.candidates).toEqual(["snps-provider/a"])
	})

	it("falls back to benched models rather than returning nothing", () => {
		const configured = rules({ pool, routes: [{ name: "r", use: pool }] })
		const decision = selectCandidates({
			rules: configured,
			features: features(),
			isHealthy: () => false,
		})
		expect(decision.candidates).toEqual(pool)
	})

	it("keeps only image-capable models when the request carries images", () => {
		const known = {
			"snps-provider/a": { id: "snps-provider/a", name: "a", contextWindow: 100_000, capabilities: ["tools"] },
			"snps-provider/b": {
				id: "snps-provider/b",
				name: "b",
				contextWindow: 100_000,
				capabilities: ["tools", "images"],
			},
		} as never
		const configured = rules({ pool, routes: [{ name: "r", use: pool }] })
		const decision = selectCandidates({
			rules: configured,
			features: features({ hasImages: true }),
			knownModels: known,
			isHealthy: alwaysHealthy,
		})
		expect(decision.candidates).toEqual(["snps-provider/b"])
		expect(decision.excludedNoImages).toEqual(["snps-provider/a", "snps-provider/c"])
	})

	it("yields no candidates for an image request when no model accepts images", () => {
		const configured = rules({ pool, routes: [{ name: "r", use: pool }] })
		const decision = selectCandidates({
			rules: configured,
			features: features({ hasImages: true }),
			knownModels: undefined,
			isHealthy: alwaysHealthy,
		})
		// Unlike health and size, this filter is never relaxed.
		expect(decision.candidates).toEqual([])
		expect(decision.excludedNoImages).toEqual(pool)
	})

	it("names the route default when none match", () => {
		const configured = rules({
			pool,
			routes: [{ name: "never", when: { minEstimatedTokens: 999_999 }, use: pool }],
		})
		const decision = selectCandidates({
			rules: configured,
			features: features(),
			isHealthy: alwaysHealthy,
		})
		expect(decision.routeName).toBe("default")
		expect(decision.candidates).toEqual(pool)
	})
})
