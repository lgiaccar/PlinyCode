import { expect, test } from "bun:test";
import { sum } from "./math";

test("sum adds every value", () => {
	expect(sum([1, 2, 3])).toBe(6);
});

test("sum of nothing is zero", () => {
	expect(sum([])).toBe(0);
});
