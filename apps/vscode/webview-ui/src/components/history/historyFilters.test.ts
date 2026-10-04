import { describe, expect, it } from "vitest"
import { dateFilterRange, groupHistoryTasks } from "./historyFilters"

describe("dateFilterRange", () => {
	// Local time throughout: the filter follows the user's calendar days.
	const now = new Date(2026, 2, 10, 15, 30)
	const noCustom = { from: "", to: "" }

	it("leaves both sides open for any time", () => {
		expect(dateFilterRange("any", noCustom, now)).toEqual({ fromTs: 0, toTs: 0 })
	})

	it("starts today at local midnight", () => {
		expect(dateFilterRange("today", noCustom, now)).toEqual({ fromTs: new Date(2026, 2, 10).getTime(), toTs: 0 })
	})

	it("counts today as the last of the 7 and 30 days", () => {
		expect(dateFilterRange("last7", noCustom, now).fromTs).toBe(new Date(2026, 2, 4).getTime())
		expect(dateFilterRange("last30", noCustom, now).fromTs).toBe(new Date(2026, 1, 9).getTime())
	})

	it("reads the custom range as local date-times and includes the whole end minute", () => {
		expect(dateFilterRange("custom", { from: "2026-03-01T09:00", to: "2026-03-02T18:30" }, now)).toEqual({
			fromTs: new Date(2026, 2, 1, 9, 0).getTime(),
			toTs: new Date(2026, 2, 2, 18, 30, 59, 999).getTime(),
		})
	})

	it("leaves a blank or unreadable custom side open", () => {
		expect(dateFilterRange("custom", { from: "2026-03-01T09:00", to: "" }, now).toTs).toBe(0)
		expect(dateFilterRange("custom", { from: "", to: "not a date" }, now)).toEqual({ fromTs: 0, toTs: 0 })
	})
})

describe("groupHistoryTasks", () => {
	const now = new Date(2026, 2, 10, 15, 30)
	const today = new Date(2026, 2, 10, 9, 0).getTime()
	const lastWeek = new Date(2026, 2, 3, 9, 0).getTime()
	const task = (id: string, ts: number, isPinned = false) => ({ id, ts, isPinned })
	const ids = (tasks: { id: string }[]) => tasks.map((item) => item.id)

	it("puts pinned conversations in their own first section, whatever their date", () => {
		const grouped = groupHistoryTasks(
			[task("pinned-old", lastWeek, true), task("a", today), task("pinned-new", today, true), task("b", lastWeek)],
			{ groupByDay: true, now },
		)

		expect(grouped.groupLabels).toEqual(["Pinned", "Today", "Older"])
		expect(grouped.groupCounts).toEqual([2, 1, 1])
		expect(ids(grouped.tasks)).toEqual(["pinned-old", "pinned-new", "a", "b"])
	})

	it("shows only the sections that have conversations", () => {
		expect(groupHistoryTasks([task("b", lastWeek)], { groupByDay: true, now }).groupLabels).toEqual(["Older"])
		expect(groupHistoryTasks([task("p", lastWeek, true)], { groupByDay: true, now }).groupLabels).toEqual(["Pinned"])
		expect(groupHistoryTasks([], { groupByDay: true, now })).toEqual({ tasks: [], groupCounts: [], groupLabels: [] })
	})

	it("keeps one unlabelled section for the other sorts until something is pinned", () => {
		const unpinned = groupHistoryTasks([task("a", today), task("b", lastWeek)], { groupByDay: false, now })
		expect(unpinned.groupLabels).toEqual([""])
		expect(unpinned.groupCounts).toEqual([2])

		const withPin = groupHistoryTasks([task("p", lastWeek, true), task("a", today), task("b", lastWeek)], {
			groupByDay: false,
			now,
		})
		expect(withPin.groupLabels).toEqual(["Pinned", "Others"])
		expect(withPin.groupCounts).toEqual([1, 2])
		expect(ids(withPin.tasks)).toEqual(["p", "a", "b"])
	})
})
