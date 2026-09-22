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
			// Only the tool-call contract is asserted here: image support is
			// model-specific and the default has moved between models.
			capabilities: expect.arrayContaining(["streaming", "tools"]),
		});
		expect(models["snps-provider/GLM-5.2"]?.contextWindow).toBe(512_000);
		expect(models["snps-google-gcp/gemini-3.1-pro-preview"]).toBeUndefined();
	});

	it("points at the Pliny gateway base URL", () => {
		expect(PLINY_BASE_URL).toBe(
			"https://snps-inference.internal.synopsys.com/api/llm",
		);
	});

	it("gives every self-hosted model explicit zero pricing", () => {
		const models = buildPlinyModels();
		expect(models[PLINY_DEFAULT_MODEL_ID]?.metadata?.selfHosted).toBe(true);
		expect(models[PLINY_DEFAULT_MODEL_ID]?.pricing).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(models["snps-provider/GLM-5.2"]?.pricing).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	it("maps catalog pricing onto priced hosted models", () => {
		const models = buildPlinyModels();
		const sonnet = models["snps-aws-bedrock/global.anthropic.claude-sonnet-5"];
		expect(sonnet?.pricing).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 3.75,
		});
		expect(sonnet?.metadata?.priceSource).toContain("PUBLIC_ESTIMATE");

		const flash = models["snps-google-gcp/gemini-2-5-flash"];
		expect(flash?.pricing).toEqual({ input: 0.3, output: 2.5 });
	});

	it("leaves pricing undefined for hosted models with no confirmed price", () => {
		const models = buildPlinyModels();
		expect(models["azure-openai/gpt-5.2"]?.pricing).toBeUndefined();
		expect(models["azure-openai/Kimi-K2.6"]?.pricing).toBeUndefined();
		expect(models["google-vertex/glm-5.2"]?.pricing).toBeUndefined();
	});
});
