import { describe, expect, it } from "vitest"
import { checkConversationBudget, formatSpendingLimitMessage } from "./spending-limit"

describe("checkConversationBudget", () => {
	it("lets a conversation spend up to its budget", () => {
		expect(checkConversationBudget(0, 5, 5)).toBeUndefined()
		expect(checkConversationBudget(4.99, 5, 5)).toBeUndefined()
	})

	it("pauses at the budget and raises it by one step, rounded up to cents", () => {
		expect(checkConversationBudget(5.2, 5, 5)).toEqual({ spent: 5.2, budget: 5, nextBudget: 10.2 })
		expect(checkConversationBudget(10.2345, 10.2, 5)?.nextBudget).toBe(15.24)
	})

	it("steps by the conversation's own budget when the default is off", () => {
		expect(checkConversationBudget(20.5, 20, 0)?.nextBudget).toBe(40.5)
	})

	it("is off when the budget is 0", () => {
		expect(checkConversationBudget(1000, 0, 5)).toBeUndefined()
	})

	it("ignores a spend that is not a number", () => {
		expect(checkConversationBudget(Number.NaN, 5, 5)).toBeUndefined()
	})

	it("explains how to continue and where to change the budget", () => {
		const text = formatSpendingLimitMessage({ spent: 5.123, budget: 5, nextBudget: 10.13 })
		expect(text).toContain("spent $5.12")
		expect(text).toContain("$5.00 budget")
		expect(text).toContain("budget is now $10.13")
		expect(text).toContain("task header")
	})
})
