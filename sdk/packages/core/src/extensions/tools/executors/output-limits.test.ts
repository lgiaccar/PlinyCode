import { describe, expect, it } from "vitest";
import { capOperationResultsTotal } from "./output-limits";

const entry = (query: string, chars: number) => ({
	query,
	result: "r".repeat(chars),
	success: true,
});

describe("capOperationResultsTotal", () => {
	it("leaves a call within its budget alone", () => {
		const results = [entry("a", 10_000), entry("b", 10_000)];
		expect(capOperationResultsTotal(results, 32_000, "hint")).toEqual(results);
	});

	it("cuts the entry that crosses the budget and elides the ones after it", () => {
		const results = [entry("a", 20_000), entry("b", 20_000), entry("c", 100)];
		const capped = capOperationResultsTotal(
			results,
			32_000,
			"Send fewer queries.",
		);
		expect(capped[0]).toEqual(results[0]);
		expect(capped[1].result.length).toBeLessThan(13_000);
		expect(capped[1].result).toContain(
			"output budget of 32000 chars is spent. Send fewer queries.",
		);
		expect(capped[2].result).toContain("result elided");
		expect(capped[2].query).toBe("c");
	});

	it("never cuts an entry below the minimum, and skips non-string results", () => {
		const image = { query: "img", result: [{ type: "image" }], success: true };
		const results = [entry("a", 31_500), image, entry("b", 5_000)];
		const capped = capOperationResultsTotal(results, 32_000, "hint");
		expect(capped[1]).toBe(image);
		expect(capped[2].result.length).toBeGreaterThan(2_000);
		expect(capped[2].result).toContain("cut to 2000 chars");
	});
});
