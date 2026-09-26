import { describe, expect, it } from "vitest"
import { ConversationSpendingGuard, formatSpendingLimitMessage } from "./spending-limit"

describe("ConversationSpendingGuard", () => {
	it("lets a conversation spend up to the limit", () => {
		const guard = new ConversationSpendingGuard()
		expect(guard.check("t1", 0, 5)).toBeUndefined()
		expect(guard.check("t1", 4.99, 5)).toBeUndefined()
	})

	it("pauses at the limit and allows one more round after that", () => {
		const guard = new ConversationSpendingGuard()
		expect(guard.check("t1", 5.2, 5)).toEqual({ spent: 5.2, limit: 5, nextThreshold: 10.2 })
		expect(guard.check("t1", 9, 5)).toBeUndefined()
		expect(guard.check("t1", 10.3, 5)?.nextThreshold).toBeCloseTo(15.3)
	})

	it("tracks conversations separately", () => {
		const guard = new ConversationSpendingGuard()
		expect(guard.check("t1", 6, 5)).toBeDefined()
		expect(guard.check("t2", 1, 5)).toBeUndefined()
	})

	it("is off when the limit is 0", () => {
		const guard = new ConversationSpendingGuard()
		expect(guard.check("t1", 1000, 0)).toBeUndefined()
	})

	it("applies a raised limit right away and forgets on request", () => {
		const guard = new ConversationSpendingGuard()
		expect(guard.check("t1", 5, 5)).toBeDefined() // next pause at 10
		expect(guard.check("t1", 12, 20)).toBeUndefined() // raised to 20
		guard.forget("t1")
		expect(guard.check("t1", 12, 5)).toBeDefined()
	})

	it("explains how to continue and where to change the limit", () => {
		const text = formatSpendingLimitMessage({ spent: 5.123, limit: 5, nextThreshold: 10.123 })
		expect(text).toContain("$5.12")
		expect(text).toContain("next pause at $10.12")
		expect(text).toContain("plinycode.spending.conversationLimit")
	})
})
