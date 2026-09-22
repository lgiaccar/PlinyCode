import { describe, expect, it } from "vitest"
import { formatChangedFilesSummaryLine, formatChangedFilesTotalLineCount } from "./formatChangedFilesSummary"

describe("formatChangedFilesSummary", () => {
	it("formats plural and singular file counts with line deltas", () => {
		expect(formatChangedFilesSummaryLine({ fileCount: 10, totalAdded: 300, totalRemoved: 45 })).toBe(
			"10 files edited, +300 / -45 lines",
		)
		expect(formatChangedFilesSummaryLine({ fileCount: 1, totalAdded: 2, totalRemoved: 0 })).toBe(
			"1 file edited, +2 / -0 lines",
		)
	})

	it("sums total line churn", () => {
		expect(formatChangedFilesTotalLineCount(300, 45)).toBe(345)
	})
})
