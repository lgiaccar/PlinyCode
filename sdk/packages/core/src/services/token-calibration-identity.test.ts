import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTokenCalibration, observeTokenCalibration } from "@plinycode/llms";
import { tokenCalibration } from "@plinycode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistTokenCalibration } from "./token-calibration-file";

/**
 * The provider layer (llms) teaches the token calibration and the engine
 * (core) reads and persists it. Both must hold the one instance shared
 * exports: the llms bundle used to carry its own copy of shared, so the
 * engine's calibration stayed empty and the file was never written.
 */
describe("token calibration identity", () => {
	const dirs: string[] = [];
	afterEach(() => {
		tokenCalibration.clear();
		vi.useRealTimers();
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is one object for llms and shared", () => {
		expect(getTokenCalibration()).toBe(tokenCalibration);
	});

	it("persists what the provider layer observes", () => {
		vi.useFakeTimers();
		const dir = mkdtempSync(join(tmpdir(), "token-calibration-identity-"));
		dirs.push(dir);
		const filePath = join(dir, "token-calibration.json");
		const dispose = persistTokenCalibration(filePath, { saveDelayMs: 1 });
		const request = {
			systemPrompt: "x".repeat(30_000),
			messages: [],
			tools: [],
			modelId: "snps-provider/kimi-k2.6",
			metadata: { sessionModelId: "pliny/auto-free" },
		};
		for (let index = 0; index < 3; index += 1) {
			observeTokenCalibration(
				{
					inputTokens: 10_000,
					outputTokens: 1,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				} as Parameters<typeof observeTokenCalibration>[0],
				request as Parameters<typeof observeTokenCalibration>[1],
			);
		}
		vi.advanceTimersByTime(5);
		dispose();
		const saved = JSON.parse(readFileSync(filePath, "utf8")) as {
			models: Record<string, { samples: number }>;
		};
		expect(saved.models["pliny/auto-free"]?.samples).toBe(3);
	});
});
