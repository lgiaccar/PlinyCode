import { describe, expect, it } from "vitest";
import {
	buildPlinyModels,
	canonicalPlinyModelId,
	isPlinyBalanceAutoModelId,
	isPlinyFreeAutoModelId,
	isPlinyFreeModelId,
	isPlinyRouterModelId,
	isPlinySelfHostedModelId,
	PLINY_BALANCE_AUTO_MODEL_ID,
	PLINY_BASE_URL,
	PLINY_DEFAULT_MODEL_ID,
	PLINY_FREE_AUTO_FALLBACK_MODEL_ID,
	PLINY_FREE_AUTO_MODEL_ID,
	PLINY_FREE_AUTO_PROFILES,
	PLINY_ROUTER_PROFILES,
	plinyFreeAutoModelId,
	plinyFreeAutoProfile,
	plinyFreePoolIds,
	plinyHostedPoolIds,
	plinyRouterModelId,
	plinyRouterProfile,
	plinyRouterProfileAllowsPaid,
	plinyThinkingControls,
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

	it("maps every profile id onto a real model too", () => {
		expect(resolvePlinyConcreteModelId("pliny/auto-free-fast")).toBe(
			PLINY_FREE_AUTO_FALLBACK_MODEL_ID,
		);
	});
});

describe("FreeAuto profiles", () => {
	it("keeps the bare id for the default profile", () => {
		expect(plinyFreeAutoModelId("default")).toBe(PLINY_FREE_AUTO_MODEL_ID);
		expect(plinyFreeAutoProfile(PLINY_FREE_AUTO_MODEL_ID)).toBe("default");
	});

	it("round-trips every profile through its id", () => {
		for (const { profile } of PLINY_FREE_AUTO_PROFILES) {
			const id = plinyFreeAutoModelId(profile);
			expect(isPlinyFreeAutoModelId(id)).toBe(true);
			expect(plinyFreeAutoProfile(id)).toBe(profile);
		}
	});

	it("lists every profile as a free, zero-priced router model at the top of the catalog", () => {
		const models = buildPlinyModels();
		const ids = Object.keys(models);
		PLINY_FREE_AUTO_PROFILES.forEach(({ profile }, index) => {
			const id = plinyFreeAutoModelId(profile);
			expect(ids[index]).toBe(id);
			expect(models[id]?.pricing).toMatchObject({ input: 0, output: 0 });
			expect(isPlinyFreeModelId(id)).toBe(true);
		});
	});

	it("does not treat a lookalike id as a profile", () => {
		expect(isPlinyFreeAutoModelId("pliny/auto-freedom")).toBe(false);
		expect(isPlinyFreeAutoModelId("pliny/free-autonomous")).toBe(false);
	});
});

describe("router ids from before the auto-* rename", () => {
	it("maps each legacy id onto its current id", () => {
		expect(canonicalPlinyModelId("pliny/free-auto")).toBe("pliny/auto-free");
		expect(canonicalPlinyModelId("pliny/free-auto-fast")).toBe(
			"pliny/auto-free-fast",
		);
		expect(canonicalPlinyModelId("pliny/free-auto-smart")).toBe(
			"pliny/auto-free-smart",
		);
		expect(canonicalPlinyModelId("pliny/balance-auto")).toBe(
			"pliny/auto-paid-balanced",
		);
		expect(canonicalPlinyModelId("snps-provider/GLM-5.2")).toBe(
			"snps-provider/GLM-5.2",
		);
	});

	it("still routes a legacy id to the same profile", () => {
		expect(isPlinyFreeAutoModelId("pliny/free-auto")).toBe(true);
		expect(plinyRouterProfile("pliny/free-auto-smart")).toBe("smart");
		expect(isPlinyBalanceAutoModelId("pliny/balance-auto")).toBe(true);
		expect(plinyRouterProfile("pliny/balance-auto")).toBe("balance");
		expect(isPlinyFreeModelId("pliny/balance-auto")).toBe(false);
	});
});

describe("BalanceAuto router model", () => {
	it("is a router id but not a free one", () => {
		expect(isPlinyRouterModelId(PLINY_BALANCE_AUTO_MODEL_ID)).toBe(true);
		expect(isPlinyBalanceAutoModelId(PLINY_BALANCE_AUTO_MODEL_ID)).toBe(true);
		expect(isPlinyFreeAutoModelId(PLINY_BALANCE_AUTO_MODEL_ID)).toBe(false);
		expect(isPlinyFreeModelId(PLINY_BALANCE_AUTO_MODEL_ID)).toBe(false);
		expect(isPlinySelfHostedModelId(PLINY_BALANCE_AUTO_MODEL_ID)).toBe(false);
		// Only the exact id: nothing derives profiles from it.
		expect(isPlinyBalanceAutoModelId("pliny/auto-paid-balanced-fast")).toBe(
			false,
		);
		expect(isPlinyRouterModelId("pliny/auto-paid-balanced-fast")).toBe(false);
	});

	it("is the last router profile and not a FreeAuto profile", () => {
		const last = PLINY_ROUTER_PROFILES[PLINY_ROUTER_PROFILES.length - 1];
		expect(last).toMatchObject({
			profile: "balance",
			id: PLINY_BALANCE_AUTO_MODEL_ID,
			family: "balance",
		});
		expect(
			PLINY_FREE_AUTO_PROFILES.some((entry) => entry.profile === "balance"),
		).toBe(false);
		expect(PLINY_FREE_AUTO_PROFILES).toHaveLength(
			PLINY_ROUTER_PROFILES.length - 1,
		);
	});

	it("round-trips through its profile name", () => {
		expect(plinyRouterProfile(PLINY_BALANCE_AUTO_MODEL_ID)).toBe("balance");
		expect(plinyRouterModelId("balance")).toBe(PLINY_BALANCE_AUTO_MODEL_ID);
		expect(plinyRouterProfile(PLINY_FREE_AUTO_MODEL_ID)).toBe("default");
		expect(plinyRouterProfile("pliny/auto-free-fast")).toBe("fast");
		expect(plinyRouterModelId("fast")).toBe("pliny/auto-free-fast");
	});

	it("is the only profile allowed to route to paid models", () => {
		expect(plinyRouterProfileAllowsPaid("balance")).toBe(true);
		for (const { profile } of PLINY_FREE_AUTO_PROFILES) {
			expect(plinyRouterProfileAllowsPaid(profile), profile).toBe(false);
		}
		expect(plinyRouterProfileAllowsPaid("unknown")).toBe(false);
	});

	it("sits right after the free profiles in the catalog, unpriced, with tools and images", () => {
		const models = buildPlinyModels();
		const ids = Object.keys(models);
		expect(ids[PLINY_FREE_AUTO_PROFILES.length]).toBe(
			PLINY_BALANCE_AUTO_MODEL_ID,
		);
		const router = models[PLINY_BALANCE_AUTO_MODEL_ID];
		expect(router?.capabilities).toEqual(
			expect.arrayContaining(["streaming", "tools", "images"]),
		);
		expect(router?.metadata).toMatchObject({
			provider: "pliny",
			router: true,
			routerProfile: "balance",
			selfHosted: false,
			paid: true,
		});
		// Billing follows the concrete model each call lands on.
		expect(router?.pricing).toBeUndefined();
	});

	it("maps onto the free fallback for direct gateway callers", () => {
		expect(resolvePlinyConcreteModelId(PLINY_BALANCE_AUTO_MODEL_ID)).toBe(
			PLINY_FREE_AUTO_FALLBACK_MODEL_ID,
		);
	});
});

describe("hosted pool", () => {
	it("contains only tool-call-capable paid models from the catalog", () => {
		const pool = plinyHostedPoolIds();
		const models = buildPlinyModels();
		expect(pool.length).toBeGreaterThan(5);
		expect(pool.every((id) => !isPlinySelfHostedModelId(id))).toBe(true);
		expect(pool.every((id) => models[id] !== undefined)).toBe(true);
		expect(pool).toContain("snps-aws-bedrock/global.anthropic.claude-sonnet-5");
		expect(pool).not.toContain("snps-google-gcp/gemini-3.1-pro-preview");
	});
});

describe("measured thinking controls", () => {
	it("records the probe verdict for every free pool model", () => {
		for (const id of plinyFreePoolIds()) {
			expect(plinyThinkingControls(id), id).toBeDefined();
		}
	});

	it("marks models that can reason with the reasoning capability", () => {
		const models = buildPlinyModels();
		expect(models["snps-provider/GLM-5.2"]?.capabilities).toContain(
			"reasoning",
		);
		expect(
			models["snps-provider/qwen3-coder-480b-a35b-inst-fp8"]?.capabilities,
		).not.toContain("reasoning");
	});

	it("never guesses controls for hosted models", () => {
		expect(
			plinyThinkingControls("snps-aws-bedrock/aws-claude-sonnet-4.6"),
		).toBeUndefined();
	});
});
