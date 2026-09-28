import type { GatewayProviderContext } from "@plinycode/shared";
import { describe, expect, it } from "vitest";
import {
	BUILTIN_PROVIDER_MANIFESTS_BY_ID,
	BUILTIN_SPECS,
	resolveProviderApiLineBaseUrl,
} from "./builtins";
import { getModelsForProvider, getProvider } from "./model-registry";
import { GENERATED_PROVIDER_SPECS } from "./providers.generated";
import { resolveAnthropicReasoningRequestPolicy } from "./routing/anthropic-compatible";

describe("baked anthropic catalog reasoning options", () => {
	// Regression guard for the offline fallback: when the live models.dev
	// fetch fails, models resolve from the baked catalog. If that catalog
	// drops reasoningOptions, adaptive-era Claude models fall back to the
	// manual thinking wire shape and every reasoning request is rejected by
	// the Anthropic API.
	it("carries effort options that resolve to adaptive thinking for adaptive-era Claude models", async () => {
		const models = await getModelsForProvider("anthropic");
		const adaptiveEraModelIds = [
			"claude-sonnet-5",
			"claude-fable-5",
			"claude-opus-5",
			"claude-opus-4-8",
			"claude-opus-4-7",
			"claude-opus-4-6",
			"claude-sonnet-4-6",
		];

		for (const modelId of adaptiveEraModelIds) {
			const model = models[modelId];
			expect(model, modelId).toBeDefined();
			expect(
				model.reasoningOptions?.some((option) => option.type === "effort"),
				modelId,
			).toBe(true);

			const context: GatewayProviderContext = {
				provider: {
					id: "anthropic",
					name: "Anthropic",
					defaultModelId: modelId,
					models: [],
					metadata: {
						routing: {
							reasoning: {
								format: "anthropic-thinking",
								routes: [{ matcher: "anthropic-compatible" }],
							},
						},
					},
				},
				model: {
					id: modelId,
					name: model.name,
					providerId: "anthropic",
					reasoningOptions: model.reasoningOptions,
					metadata: model.family ? { family: model.family } : undefined,
				},
				config: { providerId: "anthropic" },
			};
			expect(
				resolveAnthropicReasoningRequestPolicy(
					{
						providerId: "anthropic",
						modelId,
						messages: [],
						reasoning: { enabled: true },
					},
					context,
				),
				modelId,
			).toEqual({ kind: "anthropic-adaptive" });
		}
	});
});

describe("built-in provider metadata", () => {
	it("registers ElevenLabs Scribe v2 as a dedicated transcription provider", async () => {
		await expect(getProvider("elevenlabs")).resolves.toMatchObject({
			id: "elevenlabs",
			name: "ElevenLabs",
			baseUrl: "https://api.elevenlabs.io/v1",
			defaultModelId: "scribe_v2",
			client: "fetch",
		});
		await expect(getModelsForProvider("elevenlabs")).resolves.toEqual({
			scribe_v2: expect.objectContaining({
				id: "scribe_v2",
				operation: "transcription",
				operationModes: ["batch"],
				modalities: {
					input: ["audio"],
					output: ["text"],
				},
			}),
		});
		expect(BUILTIN_PROVIDER_MANIFESTS_BY_ID.elevenlabs).toMatchObject({
			modelOperationCapabilities: [
				{
					operation: "transcription",
					modes: ["batch"],
				},
			],
			metadata: { transcriptionTransport: "elevenlabs" },
		});
		expect(BUILTIN_PROVIDER_MANIFESTS_BY_ID["vercel-ai-gateway"]).toMatchObject(
			{
				modelOperationCapabilities: expect.arrayContaining([
					expect.objectContaining({
						operation: "transcription",
						modes: ["batch", "streaming"],
					}),
				]),
				metadata: { transcriptionTransport: "vercel-ai-gateway" },
			},
		);
	});

	it("merges generated provider specs with handwritten built-in overrides", async () => {
		const generatedIds = new Set(
			GENERATED_PROVIDER_SPECS.map((spec) => spec.id),
		);
		const builtinIds = new Set(BUILTIN_SPECS.map((spec) => spec.id));

		// Only generated providers served by a shipped adapter (Anthropic or
		// OpenAI-compatible chat completions) become built-ins.
		for (const spec of GENERATED_PROVIDER_SPECS) {
			const shipped =
				(spec.family === "openai-compatible" || spec.family === "anthropic") &&
				spec.protocol !== "openai-responses" &&
				spec.client !== "openai";
			expect(builtinIds.has(spec.id), spec.id).toBe(shipped);
		}
		expect(generatedIds.has("alibaba")).toBe(true);
		expect(generatedIds.has("cohere")).toBe(false);

		await expect(getProvider("alibaba")).resolves.toMatchObject({
			id: "alibaba",
			client: "openai-compatible",
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		});
		await expect(getModelsForProvider("alibaba")).resolves.toHaveProperty(
			"qwen3.7-plus",
		);

		// Mistral needs its own AI SDK adapter, which PlinyCode does not ship.
		expect(generatedIds.has("mistral")).toBe(true);
		expect(builtinIds.has("mistral")).toBe(false);
	});

	it("uses generated specs directly when no runtime override is required", () => {
		// moonshot is intentionally absent: it carries a Cline-specific
		// regional routing override (apiLineBaseUrls) on top of its generated
		// spec. wandb is absent because it carries a CoreWeave branding override.
		const generatedOnlyProviderIds = [
			"fireworks",
			"poolside",
			"nebius",
			"baseten",
			"requesty",
			"huggingface",
			"xiaomi",
			"tencent-tokenhub",
		] as const;

		for (const providerId of generatedOnlyProviderIds) {
			expect(BUILTIN_SPECS.find((spec) => spec.id === providerId)).toEqual(
				GENERATED_PROVIDER_SPECS.find((spec) => spec.id === providerId),
			);
		}
	});

	it("preserves W&B connection settings under the CoreWeave display name", () => {
		const generated = GENERATED_PROVIDER_SPECS.find(
			(spec) => spec.id === "wandb",
		);
		const builtin = BUILTIN_SPECS.find((spec) => spec.id === "wandb");

		expect(generated).toBeDefined();
		expect(builtin).toEqual({
			...generated,
			name: "CoreWeave",
			description: "CoreWeave Serverless Inference",
			docsUrl: "https://docs.wandb.ai/inference/",
		});
	});

	it("marks popular providers with a provider capability and rank", async () => {
		await expect(getProvider("pliny")).resolves.toMatchObject({
			name: "Pliny",
			capabilities: expect.arrayContaining(["popular"]),
			metadata: { popularRank: 1 },
		});
		await expect(getProvider("zai")).resolves.not.toMatchObject({
			capabilities: expect.arrayContaining(["popular"]),
		});
	});

	it("uses the current Hugging Face router endpoint", async () => {
		await expect(getProvider("huggingface")).resolves.toMatchObject({
			baseUrl: "https://router.huggingface.co/v1",
		});
	});

	it("routes native Z.AI providers through GLM thinking metadata", async () => {
		for (const providerId of ["zai", "zai-coding-plan"] as const) {
			await expect(getProvider(providerId)).resolves.toMatchObject({
				metadata: {
					routing: {
						reasoning: {
							format: "glm-thinking",
						},
					},
				},
			});

			const models = Object.values(await getModelsForProvider(providerId));
			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				expect(model.family?.startsWith("glm")).toBe(true);
			}
		}
	});

	it("routes direct MiniMax M3 through MiniMax thinking metadata", async () => {
		await expect(getProvider("minimax")).resolves.toMatchObject({
			metadata: {
				routing: {
					reasoning: {
						format: "minimax-thinking",
						routes: [
							expect.objectContaining({
								matcher: "model-id",
								modelId: "MiniMax-M3",
							}),
						],
					},
				},
			},
		});
	});
});

describe("regional API line base URLs", () => {
	it("exposes china/international endpoints on regional provider specs", () => {
		const expectations: Record<
			string,
			{ china: string; international: string }
		> = {
			qwen: {
				china: "https://dashscope.aliyuncs.com/compatible-mode/v1",
				international: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			},
			"qwen-code": {
				china: "https://dashscope.aliyuncs.com/compatible-mode/v1",
				international: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
			},
			moonshot: {
				china: "https://api.moonshot.cn/v1",
				international: "https://api.moonshot.ai/v1",
			},
			zai: {
				china: "https://open.bigmodel.cn/api/paas/v4",
				international: "https://api.z.ai/api/paas/v4",
			},
			"zai-coding-plan": {
				china: "https://open.bigmodel.cn/api/coding/paas/v4",
				international: "https://api.z.ai/api/coding/paas/v4",
			},
			minimax: {
				china: "https://api.minimaxi.com/anthropic/v1",
				international: "https://api.minimax.io/anthropic/v1",
			},
		};

		for (const [providerId, expected] of Object.entries(expectations)) {
			const spec = BUILTIN_SPECS.find((s) => s.id === providerId);
			expect(spec?.apiLineBaseUrls, providerId).toEqual(expected);
		}
	});

	it("resolves the regional base URL for a selected api line", () => {
		expect(resolveProviderApiLineBaseUrl("zai", "china")).toBe(
			"https://open.bigmodel.cn/api/paas/v4",
		);
		expect(resolveProviderApiLineBaseUrl("moonshot", "china")).toBe(
			"https://api.moonshot.cn/v1",
		);
		expect(resolveProviderApiLineBaseUrl("qwen", "international")).toBe(
			"https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		);
	});

	it("returns undefined for unknown lines and non-regional providers", () => {
		expect(resolveProviderApiLineBaseUrl("zai", undefined)).toBeUndefined();
		expect(resolveProviderApiLineBaseUrl("zai", "mars")).toBeUndefined();
		expect(resolveProviderApiLineBaseUrl("anthropic", "china")).toBeUndefined();
	});

	it("keeps the international line consistent with the spec default base URL for zai and moonshot", () => {
		for (const providerId of ["zai", "moonshot", "minimax"]) {
			const spec = BUILTIN_SPECS.find((s) => s.id === providerId);
			expect(spec?.apiLineBaseUrls?.international, providerId).toBe(
				spec?.defaults?.baseUrl,
			);
		}
	});
});
