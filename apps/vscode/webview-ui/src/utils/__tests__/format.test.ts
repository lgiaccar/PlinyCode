import { describe, expect, it } from "vitest"
import { formatStartTime } from "../format"

describe("formatStartTime", () => {
	const now = new Date(2026, 8, 25, 18, 0).getTime()

	it("names today and yesterday", () => {
		expect(formatStartTime(new Date(2026, 8, 25, 17, 53).getTime(), now)).toBe("Today, 5:53 PM")
		expect(formatStartTime(new Date(2026, 8, 24, 9, 2).getTime(), now)).toBe("Yesterday, 9:02 AM")
	})

	it("gives the date for older conversations, with the year only when it differs", () => {
		expect(formatStartTime(new Date(2026, 8, 21, 17, 53).getTime(), now)).toBe("Sep 21, 5:53 PM")
		expect(formatStartTime(new Date(2025, 11, 30, 17, 53).getTime(), now)).toBe("Dec 30, 2025, 5:53 PM")
	})

	it("handles yesterday across a month boundary", () => {
		const firstOfMonth = new Date(2026, 9, 1, 8, 0).getTime()
		expect(formatStartTime(new Date(2026, 8, 30, 23, 15).getTime(), firstOfMonth)).toBe("Yesterday, 11:15 PM")
	})
})
