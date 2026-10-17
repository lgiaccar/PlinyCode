import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TokenCalibration } from "@plinycode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistTokenCalibration } from "./token-calibration-file";

function observeTimes(
	calibration: TokenCalibration,
	model: string,
	charsPerToken: number,
	now: number,
) {
	for (let index = 0; index < 3; index++) {
		calibration.observe(model, charsPerToken * 10_000, 10_000, now);
	}
}

describe("persistTokenCalibration", () => {
	const dirs: string[] = [];
	const tempFile = () => {
		const dir = mkdtempSync(join(tmpdir(), "token-calibration-"));
		dirs.push(dir);
		return join(dir, "nested", "token-calibration.json");
	};

	afterEach(() => {
		vi.useRealTimers();
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("saves after observations and restores in a new process", () => {
		vi.useFakeTimers();
		const filePath = tempFile();
		const calibration = new TokenCalibration();
		const dispose = persistTokenCalibration(filePath, {
			calibration,
			saveDelayMs: 1_000,
		});
		observeTimes(calibration, "model-a", 4, 1);
		expect(existsSync(filePath)).toBe(false);
		vi.advanceTimersByTime(1_000);
		expect(existsSync(filePath)).toBe(true);
		dispose();

		const restored = new TokenCalibration();
		persistTokenCalibration(filePath, { calibration: restored })();
		expect(restored.charsPerToken("model-a")).toBeCloseTo(4, 5);
	});

	it("writes a pending change when disposed", () => {
		const filePath = tempFile();
		const calibration = new TokenCalibration();
		const dispose = persistTokenCalibration(filePath, {
			calibration,
			saveDelayMs: 60_000,
		});
		observeTimes(calibration, "model-a", 2.5, 1);
		dispose();
		const saved = JSON.parse(readFileSync(filePath, "utf8"));
		expect(saved.models["model-a"].charsPerToken).toBeCloseTo(2.5, 5);
	});

	it("merges entries another window saved in the meantime", () => {
		const filePath = tempFile();
		const calibration = new TokenCalibration();
		const dispose = persistTokenCalibration(filePath, {
			calibration,
			saveDelayMs: 60_000,
		});
		const other = new TokenCalibration();
		observeTimes(other, "model-b", 4.5, 5);
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, JSON.stringify(other.snapshot()));
		observeTimes(calibration, "model-a", 3.5, 6);
		dispose();
		const saved = JSON.parse(readFileSync(filePath, "utf8"));
		expect(Object.keys(saved.models).sort()).toEqual(["model-a", "model-b"]);
	});

	it("starts empty from a missing or corrupt file", () => {
		const filePath = tempFile();
		const calibration = new TokenCalibration();
		persistTokenCalibration(filePath, { calibration })();
		expect(calibration.snapshot().models).toEqual({});
	});
});
