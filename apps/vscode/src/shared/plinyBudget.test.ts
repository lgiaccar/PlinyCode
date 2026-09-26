import { describe, expect, it } from "bun:test"
import { parsePlinyBudget, plinyBudgetPeriodLabel } from "./plinyBudget"

const MONTHLY = {
	matched: [
		{
			name: "default-budget-rule",
			type: "tenant-budget-config",
			team_name: null,
			applies_to: "per-user",
			mode: "enforce",
			entities: [
				{
					entity: "{user:someone@synopsys.com}",
					periods: {
						cost_per_month: {
							limit: 200,
							used: 111.92079867000005,
							percentage: 55.96,
							start: 1788220800,
							end: 1790812799,
							is_blocked: false,
						},
					},
				},
			],
		},
	],
}

describe("parsePlinyBudget", () => {
	it("reads the monthly budget from the gateway response", () => {
		const budget = parsePlinyBudget(MONTHLY)
		expect(budget).toMatchObject({
			limit: 200,
			percentage: 55.96,
			period: "cost_per_month",
			periodEndMs: 1790812799000,
			isBlocked: false,
			mode: "enforce",
		})
		expect(budget?.remaining).toBeCloseTo(88.08, 2)
	})

	it("picks the period with the least money left", () => {
		const budget = parsePlinyBudget({
			matched: [
				...MONTHLY.matched,
				{
					mode: "enforce",
					entities: [{ periods: { cost_per_day: { limit: 20, used: 18 } } }],
				},
			],
		})
		expect(budget).toMatchObject({ period: "cost_per_day", remaining: 2, percentage: 90 })
	})

	it("prefers a blocked budget over one with money left", () => {
		const budget = parsePlinyBudget({
			matched: [
				{
					entities: [
						{
							periods: {
								cost_per_day: { limit: 20, used: 1 },
								cost_per_week: { limit: 50, used: 10, is_blocked: true },
							},
						},
					],
				},
			],
		})
		expect(budget?.period).toBe("cost_per_week")
		expect(budget?.isBlocked).toBe(true)
	})

	it("returns undefined for responses without a budget", () => {
		expect(parsePlinyBudget({})).toBeUndefined()
		expect(parsePlinyBudget({ matched: [] })).toBeUndefined()
		expect(parsePlinyBudget(null)).toBeUndefined()
		expect(parsePlinyBudget({ matched: [{ entities: [{ periods: { x: { limit: "a" } } }] }] })).toBeUndefined()
	})
})

describe("plinyBudgetPeriodLabel", () => {
	it("shortens gateway period keys", () => {
		expect(plinyBudgetPeriodLabel("cost_per_month")).toBe("month")
		expect(plinyBudgetPeriodLabel("custom")).toBe("custom")
	})
})
