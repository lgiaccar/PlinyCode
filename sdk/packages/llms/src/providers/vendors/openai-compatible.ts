import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@plinycode/shared";
import { wrapLanguageModel } from "ai";
import { resolveApiKey } from "../http";
import { splitToolImagesMiddleware } from "../middleware/split-tool-images";
import { isOpenAIReasoningEraModelId } from "../model-facts";
import { withContentBlockCacheBreakpoints } from "../routing/anthropic-compatible";
import { withSafeToolCallIds } from "../routing/tool-call-ids";
import type { ProviderFactoryResult } from "./types";

type FetchInput = Parameters<typeof fetch>[0];
type FetchWithOptionalPreconnect = typeof fetch & {
	preconnect?: (...args: unknown[]) => unknown;
};

function readAzureApiVersion(
	config: GatewayResolvedProviderConfig,
): string | undefined {
	const apiVersion = config.options?.apiVersion;
	if (typeof apiVersion !== "string") {
		return undefined;
	}
	const trimmed = apiVersion.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function shouldAddAzureApiVersion(url: URL): boolean {
	return (
		url.pathname.startsWith("/openai/deployments/") &&
		!url.searchParams.has("api-version")
	);
}

function withAzureApiVersion(
	input: FetchInput,
	apiVersion: string,
): FetchInput {
	let url: URL;
	try {
		url = new URL(input instanceof Request ? input.url : input.toString());
	} catch {
		return input;
	}
	if (!shouldAddAzureApiVersion(url)) {
		return input;
	}
	url.searchParams.set("api-version", apiVersion);
	if (input instanceof Request) {
		return new Request(url.toString(), input);
	}
	return (typeof input === "string" ? url.toString() : url) as FetchInput;
}

function createAzureApiVersionFetch(
	config: GatewayResolvedProviderConfig,
): typeof fetch | undefined {
	const apiVersion = readAzureApiVersion(config);
	if (!apiVersion) {
		return config.fetch;
	}
	const baseFetch = config.fetch ?? globalThis.fetch;
	if (!baseFetch) {
		return config.fetch;
	}
	const azureFetch = ((input, init) =>
		baseFetch(withAzureApiVersion(input, apiVersion), init)) as typeof fetch;
	const baseFetchWithPreconnect = baseFetch as FetchWithOptionalPreconnect;
	(azureFetch as FetchWithOptionalPreconnect).preconnect =
		typeof baseFetchWithPreconnect.preconnect === "function"
			? baseFetchWithPreconnect.preconnect.bind(baseFetch)
			: () => undefined;
	return azureFetch;
}

/**
 * OpenAI's chat-completions API rejects `max_tokens` for reasoning-era
 * models ("Unsupported parameter: 'max_tokens' is not supported with this
 * model. Use 'max_completion_tokens' instead."). Rename the parameter only
 * for model ids that require it: OpenAI, Azure OpenAI, and the major
 * OpenAI-compatible gateways (OpenRouter, LiteLLM) all accept
 * `max_completion_tokens`, while older third-party servers that only know
 * `max_tokens` do not serve o-series/gpt-5 model ids — so every other
 * request keeps its exact current wire format.
 */
export function withMaxCompletionTokensForReasoningModels(
	body: Record<string, unknown>,
): Record<string, unknown> {
	const { max_tokens: maxTokens, ...rest } = body;
	if (
		maxTokens == null ||
		typeof body.model !== "string" ||
		!isOpenAIReasoningEraModelId(body.model)
	) {
		return body;
	}
	return {
		...rest,
		// Keep an explicit `max_completion_tokens` passed via provider
		// options passthrough if one is already present.
		max_completion_tokens: rest.max_completion_tokens ?? maxTokens,
	};
}

export async function createOpenAICompatibleProviderModule(
	config: GatewayResolvedProviderConfig,
	context: GatewayProviderContext,
): Promise<ProviderFactoryResult> {
	// Don't preflight-check for a missing API key. If credentials are
	// missing or wrong, the provider's own response (e.g. 401) is the
	// authoritative error and is surfaced to the user as-is. This keeps
	// `llms` unopinionated about which providers do or don't need a key.
	const apiKey = await resolveApiKey(config);
	const providerFetch = createAzureApiVersionFetch(config);
	const contentBlockCache =
		context.provider.metadata?.routing?.promptCache?.wirePlacement ===
		"content-blocks";
	const provider = createOpenAICompatible({
		name: context.provider.id,
		apiKey,
		...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
		...(config.headers ? { headers: config.headers } : {}),
		...(providerFetch ? { fetch: providerFetch } : {}),
		includeUsage: true,
		transformRequestBody: (body: Record<string, unknown>) =>
			withSafeToolCallIds(
				withMaxCompletionTokensForReasoningModels(
					contentBlockCache ? withContentBlockCacheBreakpoints(body) : body,
				),
			),
	} as never);
	return {
		// Wrap each constructed model with `splitToolImagesMiddleware` so
		// `role:"tool"` messages whose `output.type === 'content'` carries
		// image-data parts get split into a placeholder text + a synthetic
		// `role:"user"` message carrying the images. The OpenAI Chat
		// Completions wire format does NOT support multimodal tool messages
		// (the `@ai-sdk/openai-compatible` chat-messages converter
		// `JSON.stringify`s the parts array, losing image bytes). The
		// middleware operates on the typed `LanguageModelV4Prompt` BEFORE
		// the converter runs, so the converter sees only text-only tool
		// messages with adjacent multimodal user messages — the wire
		// pattern that classic Cline used in production for years (see
		// `convertToOpenAiMessages` in `src/core/api/transform/openai-format.ts`
		// on origin/main).
		operations: {
			language: (modelId) =>
				wrapLanguageModel({
					model: provider(modelId) as LanguageModelV4,
					middleware: splitToolImagesMiddleware,
				}),
			imageGeneration: (modelId) => provider.imageModel(modelId),
		},
	};
}
