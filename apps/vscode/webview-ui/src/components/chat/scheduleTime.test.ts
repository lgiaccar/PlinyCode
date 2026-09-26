import { describe, expect, it } from "vitest"
import {
	composeScheduleTime,
	defaultScheduleTime,
	formatScheduledAt,
	parseScheduleTime,
	scheduleTimeParts,
	toScheduleTime,
} from "./scheduleTime"

describe("scheduleTime", () => {
	it("formats and parses the local datetime-local string", () => {
		const value = toScheduleTime(new Date(2026, 8, 26, 21, 7))
		expect(value).toBe("2026-09-26T21:07")
		expect(parseScheduleTime(value)).toEqual({ date: "2026-09-26", hour: 21, minute: 7 })
		expect(composeScheduleTime({ date: "2026-09-26", hour: 9, minute: 5 })).toBe("2026-09-26T09:05")
	})

	it("defaults to the next 5-minute boundary at least 5 minutes out", () => {
		expect(defaultScheduleTime(new Date(2026, 8, 26, 16, 52, 30))).toBe("2026-09-26T17:00")
		expect(defaultScheduleTime(new Date(2026, 8, 26, 23, 58))).toBe("2026-09-27T00:05")
	})

	it("falls back to the default pick for an empty value", () => {
		expect(scheduleTimeParts("", new Date(2026, 8, 26, 10, 0))).toEqual({ date: "2026-09-26", hour: 10, minute: 5 })
	})

	it("shows scheduled times on a 24-hour clock", () => {
		const text = formatScheduledAt(new Date(2026, 8, 26, 21, 30).getTime())
		expect(text).toContain("21:30")
		expect(text).not.toMatch(/AM|PM/i)
	})
})
