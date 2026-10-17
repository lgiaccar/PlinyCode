import { describe, expect, it, vi } from "vitest";
import {
	MAX_CALIBRATED_CHARS_PER_TOKEN,
	MIN_CALIBRATED_CHARS_PER_TOKEN,
	MIN_CALIBRATION_SAMPLES,
	TokenCalibration,
} from "./token-calibration";
import { CHARS_PER_TOKEN } from "./tokens";

const MODEL = "pliny/claude-sonnet";

describe("TokenCalibration", () => {
	it("falls back to CHARS_PER_TOKEN for unknown and barely observed models", () => {
		const calibration = new TokenCalibration();
		expect(calibration.charsPerToken(MODEL)).toBe(CHARS_PER_TOKEN);
		expect(calibration.charsPerToken(undefined)).toBe(CHARS_PER_TOKEN);
		for (let index = 1; index < MIN_CALIBRATION_SAMPLES; index++) {
			calibration.observe(MODEL, 40_000, 10_000);
		}
		expect(calibration.charsPerToken(MODEL)).toBe(CHARS_PER_TOKEN);
		calibration.observe(MODEL, 40_000, 10_000);
		expect(calibration.charsPerToken(MODEL)).toBeCloseTo(4, 5);
	});

	it("converges toward the observed ratio", () => {
		const calibration = new TokenCalibration();
		calibration.observe(MODEL, 30_000, 10_000);
		for (let index = 0; index < 40; index++) {
			calibration.observe(MODEL, 38_000, 10_000);
		}
		expect(calibration.charsPerToken(MODEL)).toBeCloseTo(3.8, 2);
	});

	it("moves gradually rather than jumping to one outlier", () => {
		const calibration = new TokenCalibration();
		for (let index = 0; index < 5; index++) {
			calibration.observe(MODEL, 30_000, 10_000);
		}
		calibration.observe(MODEL, 48_000, 10_000);
		const ratio = calibration.charsPerToken(MODEL);
		expect(ratio).toBeGreaterThan(3);
		expect(ratio).toBeLessThan(3.5);
	});

	it("clamps to the sane range", () => {
		const calibration = new TokenCalibration();
		for (let index = 0; index < 10; index++) {
			calibration.observe("dense", 15_000, 10_000);
			calibration.observe("sparse", 80_000, 10_000);
		}
		expect(calibration.charsPerToken("dense")).toBe(
			MIN_CALIBRATED_CHARS_PER_TOKEN,
		);
		expect(calibration.charsPerToken("sparse")).toBe(
			MAX_CALIBRATED_CHARS_PER_TOKEN,
		);
	});

	it("ignores small requests and implausible counts", () => {
		const calibration = new TokenCalibration();
		expect(calibration.observe(MODEL, 2_000, 500)).toBe(false);
		// Only the uncached part reported: 200k characters cannot be 5k tokens.
		expect(calibration.observe(MODEL, 200_000, 5_000)).toBe(false);
		expect(calibration.observe(MODEL, 500, 10_000)).toBe(false);
		expect(calibration.observe("", 40_000, 10_000)).toBe(false);
		expect(calibration.snapshot().models).toEqual({});
	});

	it("keeps models apart and reads the first calibrated one of a list", () => {
		const calibration = new TokenCalibration();
		for (let index = 0; index < 3; index++) {
			calibration.observe("served", 40_000, 10_000);
			calibration.observe("router", 25_000, 10_000);
		}
		expect(calibration.charsPerTokenFor(["unknown", "router"])).toBeCloseTo(
			2.5,
			5,
		);
		expect(calibration.charsPerTokenFor(["served", "router"])).toBeCloseTo(
			4,
			5,
		);
		expect(calibration.charsPerTokenFor([undefined, "unknown"])).toBe(
			CHARS_PER_TOKEN,
		);
	});

	it("survives a snapshot round trip and merges by recency", () => {
		const saved = new TokenCalibration();
		for (let index = 0; index < 3; index++) {
			saved.observe(MODEL, 40_000, 10_000, 1_000);
		}
		const restored = new TokenCalibration();
		expect(restored.load(JSON.parse(JSON.stringify(saved.snapshot())))).toBe(
			true,
		);
		expect(restored.charsPerToken(MODEL)).toBeCloseTo(4, 5);

		// A newer in-memory entry is not replaced by an older saved one.
		for (let index = 0; index < 3; index++) {
			restored.observe(MODEL, 25_000, 10_000, 2_000);
		}
		const before = restored.charsPerToken(MODEL);
		expect(restored.load(saved.snapshot())).toBe(false);
		expect(restored.charsPerToken(MODEL)).toBe(before);
	});

	it("skips malformed saved entries and clamps saved ratios", () => {
		const calibration = new TokenCalibration();
		calibration.load({
			version: 1,
			models: {
				good: { charsPerToken: 9, samples: 5, updatedAt: 1 },
				bad: { charsPerToken: "x", samples: 5, updatedAt: 1 },
				empty: { charsPerToken: 4, samples: 0, updatedAt: 1 },
			},
		});
		expect(calibration.charsPerToken("good")).toBe(
			MAX_CALIBRATED_CHARS_PER_TOKEN,
		);
		expect(Object.keys(calibration.snapshot().models)).toEqual(["good"]);
		expect(calibration.load("not a snapshot")).toBe(false);
		expect(calibration.load(null)).toBe(false);
	});

	it("notifies subscribers of kept observations only", () => {
		const calibration = new TokenCalibration();
		const listener = vi.fn();
		const unsubscribe = calibration.subscribe(listener);
		calibration.observe(MODEL, 40_000, 10_000);
		calibration.observe(MODEL, 100, 10);
		expect(listener).toHaveBeenCalledTimes(1);
		unsubscribe();
		calibration.observe(MODEL, 40_000, 10_000);
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
