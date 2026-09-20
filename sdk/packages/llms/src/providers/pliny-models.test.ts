import { describe, expect, it } from "vitest";
import {
	buildPlinyModels,
	PLINY_BASE_URL,
	PLINY_DEFAULT_MODEL_ID,
} from "./pliny-models";

describe("buildPlinyModels", () => {
	it("exposes only tool-call-capable models from the verified catalog", () => {
		const models = buildPlinyModels();
		expect(Object.keys(models).length).toBeGreaterThanOrEqual(30);
		expect(models[PLINY_DEFAULT_MODEL_ID]).toMatchObject({
			id: PLINY_DEFAULT_MODEL_ID,
			capabilities: expect.arrayContaining(["streaming", "tools", "images"]),
		});
		expect(models["snps-provider/GLM-5.2"]?.contextWindow).toBe(512_000);
		expect(models["snps-google-gcp/gemini-3.1-pro-preview"]).toBeUndefined();
	});

	it("points at the Pliny gateway base URL", () => {
		expect(PLINY_BASE_URL).toBe(
			"https://snps-inference.internal.synopsys.com/api/llm",
		);
	});
});
