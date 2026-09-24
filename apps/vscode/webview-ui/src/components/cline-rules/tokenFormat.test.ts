import { describe, expect, it } from "vitest"
import { estimateSkillListingTokens, formatTokenCount, sumEnabledTokens } from "./tokenFormat"

describe("formatTokenCount", () => {
	it("keeps small counts exact and abbreviates thousands", () => {
		expect(formatTokenCount(0)).toBe("0")
		expect(formatTokenCount(999)).toBe("999")
		expect(formatTokenCount(1000)).toBe("1k")
		expect(formatTokenCount(1250)).toBe("1.3k")
		expect(formatTokenCount(14_300)).toBe("14k")
	})
})

describe("sumEnabledTokens", () => {
	it("counts only enabled files", () => {
		expect(
			sumEnabledTokens(
				[
					["/a.md", true],
					["/b.md", false],
					["/c.md", true],
				],
				{ "/a.md": 100, "/b.md": 500, "/c.md": 20 },
			),
		).toBe(120)
	})
})

describe("estimateSkillListingTokens", () => {
	it("estimates the name and description cost at three characters per token", () => {
		expect(estimateSkillListingTokens({ name: "review", description: "Review a pull request" })).toBe(11)
	})
})
