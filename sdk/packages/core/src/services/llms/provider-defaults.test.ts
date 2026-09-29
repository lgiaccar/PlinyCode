import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearLiveModelsCatalogCache,
	clearPrivateModelsCatalogCache,
	getLiveModelsCatalog,
	isPrivateModelCatalogProvider,
	resolveProviderConfig,
} from "./provider-defaults";

afterEach(() => {
	clearLiveModelsCatalogCache();
	clearPrivateModelsCatalogCache();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("isPrivateModelCatalogProvider", () => {
	it.each([
		"baseten",
		"hicap",
		"litellm",
		"poolside",
	])("recognizes %s as an endpoint-specific catalog provider", (providerId) => {
		expect(isPrivateModelCatalogProvider(providerId)).toBe(true);
	});

	it.each([
		"openrouter",
		"requesty",
		"anthropic",
	])("does not classify %s as endpoint-specific", (providerId) => {
		expect(isPrivateModelCatalogProvider(providerId)).toBe(false);
	});
});

describe("live catalog request bounds", () => {
	it("aborts stalled sources and returns a fallback catalog", async () => {
		const controllers: AbortController[] = [];
		const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
			const controller = new AbortController();
			controllers.push(controller);
			return controller.signal;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_input, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener(
							"abort",
							() => reject(init.signal?.reason),
							{ once: true },
						);
					}),
			),
		);
		const pending = getLiveModelsCatalog();
		expect(controllers.length).toBeGreaterThan(0);
		expect(timeout).toHaveBeenCalledWith(5_000);
		for (const controller of controllers) controller.abort();
		await expect(pending).resolves.toEqual({});
	});

	it("refreshes the shared feed after its cache expires", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const fetchMock = vi.fn(async () => Response.json({}));
		vi.stubGlobal("fetch", fetchMock);
		await getLiveModelsCatalog({ cacheTtlMs: 100 });
		await getLiveModelsCatalog({ cacheTtlMs: 100 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		now.mockReturnValue(1_101);
		await getLiveModelsCatalog({ cacheTtlMs: 100 });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("resolveProviderConfig", () => {
	it("uses catalog aliases when loading live models", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(
					JSON.stringify({
						togetherai: {
							models: {
								"vendor/live-only-model": {
									name: "Live Only Model",
									tool_call: true,
								},
							},
						},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}),
		);

		// models.dev publishes Together AI under "togetherai".
		const resolved = await resolveProviderConfig("together", {
			loadLatestOnInit: true,
			failOnError: false,
			cacheTtlMs: 0,
		});

		expect(resolved?.knownModels?.["vendor/live-only-model"]?.name).toBe(
			"Live Only Model",
		);
	});

	it("resolves ClinePass models from a single models.dev fetch", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					"cline-pass": {
						id: "cline-pass",
						npm: "@ai-sdk/openai-compatible",
						models: {
							"cline-pass/live-model": {
								name: "Live ClinePass Model",
								tool_call: true,
							},
						},
					},
					openrouter: {
						models: {
							"vendor/live-openrouter-model": {
								name: "Live OpenRouter Model",
								tool_call: true,
							},
						},
					},
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const resolved = await resolveProviderConfig("cline-pass", {
			loadLatestOnInit: true,
			failOnError: false,
			cacheTtlMs: 0,
			url: "https://models.test/api.json",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(resolved?.knownModels?.["cline-pass/live-model"]?.name).toBe(
			"Live ClinePass Model",
		);
		expect(
			resolved?.knownModels?.["vendor/live-openrouter-model"],
		).toBeUndefined();
	});

	it("uses built-in modelsSourceUrl for keyless local provider models", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(JSON.stringify({ data: [{ id: "local-llama" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const resolved = await resolveProviderConfig(
			"lmstudio",
			{ failOnError: false, cacheTtlMs: 0 },
			{
				providerId: "lmstudio",
				modelId: "",
				baseUrl: "http://tailscale-host:1234/v1",
			},
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"http://tailscale-host:1234/v1/models",
			{ method: "GET", signal: expect.any(AbortSignal) },
		);
		expect(Object.keys(resolved?.knownModels ?? {})).toEqual(["local-llama"]);
	});

	it("loads Poolside models from the authenticated models endpoint", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "poolside/laguna-xs.2",
							name: "Poolside: Laguna XS.2",
							description: "Poolside coding model",
							context_length: 131_072,
							max_completion_tokens: 8192,
							supported_features: ["tools", "reasoning"],
							supported_sampling_parameters: ["temperature"],
							input_modalities: ["text"],
							pricing: { prompt: "0", completion: "0" },
						},
					],
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const resolved = await resolveProviderConfig(
			"poolside",
			{ failOnError: true, cacheTtlMs: 0 },
			{
				providerId: "poolside",
				modelId: "poolside/laguna-m.1",
				apiKey: "poolside-key",
				baseUrl: "https://inference.poolside.ai/v1",
			},
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://inference.poolside.ai/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({
					Authorization: "Bearer poolside-key",
				}),
			}),
		);
		expect(resolved?.knownModels?.["poolside/laguna-xs.2"]).toEqual(
			expect.objectContaining({
				name: "Poolside: Laguna XS.2",
				contextWindow: 131_072,
				maxInputTokens: 131_072,
				maxTokens: 8192,
				capabilities: expect.arrayContaining([
					"streaming",
					"tools",
					"reasoning",
					"temperature",
				]),
				pricing: { input: 0, output: 0 },
				status: "active",
			}),
		);
	});

	it("falls back to /model/info for LiteLLM private models", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("no v1 route", { status: 404 }))
			.mockResolvedValueOnce(new Response("no v1 route", { status: 404 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						data: [
							{
								model_name: "private-proxy-model",
								litellm_params: { model: "openai/gpt-4o-mini" },
								model_info: {
									max_output_tokens: 64_000,
									max_input_tokens: 500_000,
									supports_vision: true,
									supports_reasoning: true,
								},
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		const resolved = await resolveProviderConfig(
			"litellm",
			{ failOnError: true, cacheTtlMs: 0 },
			{
				providerId: "litellm",
				modelId: "",
				apiKey: "litellm-key",
				baseUrl: "http://localhost:4000/v1/",
			},
		);

		expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
			"http://localhost:4000/v1/model/info",
			"http://localhost:4000/v1/model/info",
			"http://localhost:4000/model/info",
		]);
		expect(resolved?.knownModels?.["openai/gpt-4o-mini"]).toEqual(
			expect.objectContaining({
				name: "private-proxy-model",
				maxTokens: 64_000,
				maxInputTokens: 500_000,
				capabilities: expect.arrayContaining(["images", "reasoning"]),
			}),
		);
		expect(resolved?.knownModels?.["private-proxy-model"]).toEqual(
			expect.objectContaining({
				name: "private-proxy-model",
				maxTokens: 64_000,
				maxInputTokens: 500_000,
				capabilities: expect.arrayContaining(["images", "reasoning"]),
			}),
		);
		expect(Object.keys(resolved?.knownModels ?? {}).sort()).toEqual([
			"openai/gpt-4o-mini",
			"private-proxy-model",
		]);
		expect(resolved?.knownModels?.["gpt-5.4"]).toBeUndefined();
	});

	it("returns an empty authoritative LiteLLM model list without auth", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const resolved = await resolveProviderConfig(
			"litellm",
			{ failOnError: true, cacheTtlMs: 0 },
			{
				providerId: "litellm",
				modelId: "",
				baseUrl: "http://localhost:4000/v1/",
			},
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(resolved?.knownModels).toEqual({});
		expect(resolved?.knownModels?.["gpt-5.4"]).toBeUndefined();
	});

	it("does not fall back to bundled LiteLLM models when private model fetch fails non-strictly", async () => {
		const fetchMock = vi.fn(
			async () => new Response('{"error":"unauthorized"}', { status: 401 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const resolved = await resolveProviderConfig(
			"litellm",
			{ failOnError: false, cacheTtlMs: 0 },
			{
				providerId: "litellm",
				modelId: "",
				apiKey: "litellm-key",
				baseUrl: "http://localhost:4000",
			},
		);

		expect(fetchMock).toHaveBeenCalled();
		expect(resolved?.knownModels).toEqual({});
		expect(resolved?.knownModels?.["gpt-5.4"]).toBeUndefined();
	});

	it("reports attempted path, auth header, status, and body for LiteLLM model fetch failures", async () => {
		const fetchMock = vi.fn(
			async () => new Response('{"error":"unauthorized"}', { status: 401 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			resolveProviderConfig(
				"litellm",
				{ failOnError: true, cacheTtlMs: 0 },
				{
					providerId: "litellm",
					modelId: "",
					apiKey: "litellm-key",
					baseUrl: "http://localhost:4000",
				},
			),
		).rejects.toThrow(
			'/model/info (Authorization): HTTP 401: {"error":"unauthorized"}',
		);
	});
});
