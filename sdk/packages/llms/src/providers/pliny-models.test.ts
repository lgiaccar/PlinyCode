import { describe, expect, it } from "vitest";
import {
	buildPlinyModels,
	isPlinyFreeAutoModelId,
	isPlinyFreeModelId,
	isPlinySelfHostedModelId,
	PLINY_BASE_URL,
	PLINY_DEFAULT_MODEL_ID,
	PLINY_FREE_AUTO_FALLBACK_MODEL_ID,
	PLINY_FREE_AUTO_MODEL_ID,
	plinyFreePoolIds,
	resolvePlinyConcreteModelId,
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

describe("FreeAuto router model", () => {
	it("is the default model", () => {
		expect(PLINY_DEFAULT_MODEL_ID).toBe(PLINY_FREE_AUTO_MODEL_ID);
	});

	it("is present in the catalog and can call tools", () => {
		const models = buildPlinyModels();
		const router = models[PLINY_FREE_AUTO_MODEL_ID];
		expect(router).toBeDefined();
		// Without the tools capability the runtime disables tool calling for the
		// whole session, which would make the router useless.
		expect(router?.capabilities).toEqual(
			expect.arrayContaining(["streaming", "tools"]),
		);
		expect(router?.metadata).toMatchObject({ provider: "pliny", router: true });
	});

	it("declares a context window at least as large as most of the pool", () => {
		const models = buildPlinyModels();
		const routerWindow = models[PLINY_FREE_AUTO_MODEL_ID]?.contextWindow ?? 0;
		expect(routerWindow).toBeGreaterThanOrEqual(200_000);
		// At least one pool model must be able to hold a request the router
		// advertises it can take, or every large request would be unroutable.
		const poolWindows = plinyFreePoolIds().map(
			(id) => models[id]?.contextWindow ?? 0,
		);
		expect(Math.max(...poolWindows)).toBeGreaterThanOrEqual(routerWindow);
	});

	it("is not offered as a paid hosted model", () => {
		expect(isPlinyFreeModelId(PLINY_FREE_AUTO_MODEL_ID)).toBe(true);
		expect(isPlinyFreeAutoModelId(PLINY_FREE_AUTO_MODEL_ID)).toBe(true);
		// It is free, but it is not itself a self-hosted endpoint.
		expect(isPlinySelfHostedModelId(PLINY_FREE_AUTO_MODEL_ID)).toBe(false);
	});
});

describe("free pool", () => {
	it("contains only tool-call-capable self-hosted models", () => {
		const pool = plinyFreePoolIds();
		expect(pool.length).toBeGreaterThan(5);
		expect(pool.every((id) => isPlinySelfHostedModelId(id))).toBe(true);
		const models = buildPlinyModels();
		expect(pool.every((id) => models[id] !== undefined)).toBe(true);
	});

	it("excludes known-broken and tool-less models", () => {
		const pool = plinyFreePoolIds();
		expect(pool).not.toContain("snps-provider/gpt-oss-120b-3bed4");
		expect(pool).not.toContain("snps-provider/qwen3-235b-a22b-fp8-acca3");
	});
});

describe("resolvePlinyConcreteModelId", () => {
	it("maps the virtual router id onto a real model", () => {
		expect(resolvePlinyConcreteModelId(PLINY_FREE_AUTO_MODEL_ID)).toBe(
			PLINY_FREE_AUTO_FALLBACK_MODEL_ID,
		);
		// The fallback must be something the gateway can actually resolve.
		expect(buildPlinyModels()[PLINY_FREE_AUTO_FALLBACK_MODEL_ID]).toBeDefined();
	});

	it("leaves concrete ids untouched", () => {
		expect(resolvePlinyConcreteModelId("snps-provider/GLM-5.2")).toBe(
			"snps-provider/GLM-5.2",
		);
	});

	it("falls back when no id is supplied", () => {
		expect(resolvePlinyConcreteModelId(undefined)).toBe(
			PLINY_FREE_AUTO_FALLBACK_MODEL_ID,
		);
	});
});
