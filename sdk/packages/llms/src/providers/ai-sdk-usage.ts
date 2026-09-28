import type { GatewayStreamRequest } from "@plinycode/shared";
import {
	type ContextBreakdownTokens,
	estimateRequestInputTokens,
	estimateTokens,
} from "@plinycode/shared";
import type { AiSdkStreamTotalUsage, AiSdkStreamUsage } from "./vendors/types";

interface GatewayNormalizedUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokenCount?: number;
	totalCost?: number;
	/** True when the provider reported no usable usage and the numbers above are a char-based estimate. */
	estimated?: boolean;
	/** Where this request's input tokens came from (system prompt, rules, conversation, ...). */
	contextBreakdown?: ContextBreakdownTokens;
}

function getUsageValue(
	usage: Record<string, unknown>,
	...keys: string[]
): number {
	for (const key of keys) {
		const value = usage[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
		if (
			typeof value === "string" &&
			value.trim().length > 0 &&
			Number.isFinite(Number(value))
		) {
			return Number(value);
		}
	}
	return 0;
}

function getNumericValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (
		typeof value === "string" &&
		value.trim().length > 0 &&
		Number.isFinite(Number(value))
	) {
		return Number(value);
	}
	return undefined;
}

function getNestedUsageValue(
	usage: Record<string, unknown>,
	...path: string[]
): number {
	let current: unknown = usage;
	for (const key of path) {
		if (!current || typeof current !== "object") {
			return 0;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return getNumericValue(current) ?? 0;
}

type UsagePath = readonly [string] | readonly [string, string];

const REASONING_TOKEN_PATHS: UsagePath[] = [
	["outputTokenDetails", "reasoningTokens"],
	["output_tokens_details", "reasoning_tokens"],
	["completion_tokens_details", "reasoning_tokens"],
	["reasoningTokens"],
	["reasoning_tokens"],
];

function getUsageValueByPath(source: unknown, path: UsagePath): number {
	let current: unknown = source;
	for (const key of path) {
		if (!current || typeof current !== "object") {
			return 0;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return getNumericValue(current) ?? 0;
}

function firstUsageValue(sources: unknown[], paths: UsagePath[]): number {
	for (const source of sources) {
		for (const path of paths) {
			const value = getUsageValueByPath(source, path);
			if (value > 0) {
				return value;
			}
		}
	}
	return 0;
}

function extractProviderNestedUsage(
	value: unknown,
): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}

	const providerMetadata = value as Record<string, unknown>;
	for (const nestedValue of Object.values(providerMetadata)) {
		if (!nestedValue || typeof nestedValue !== "object") {
			continue;
		}

		const nestedMetadata = nestedValue as Record<string, unknown>;
		if (nestedMetadata.usage && typeof nestedMetadata.usage === "object") {
			return nestedMetadata.usage as Record<string, unknown>;
		}
	}

	return undefined;
}

function calculateUsageCostFromPricing(
	usage: Omit<GatewayNormalizedUsage, "totalCost">,
	pricingValue: unknown,
): number | undefined {
	if (!pricingValue || typeof pricingValue !== "object") {
		return undefined;
	}

	const pricing = pricingValue as Record<string, unknown>;
	const inputPrice = getNumericValue(pricing.input);
	const outputPrice = getNumericValue(pricing.output);

	if (inputPrice === undefined || outputPrice === undefined) {
		return undefined;
	}

	const cacheReadPrice = getNumericValue(pricing.cacheRead) ?? 0;
	const cacheWritePrice =
		getNumericValue(pricing.cacheWrite) ?? inputPrice * 1.25;
	const billableInputTokens = Math.max(
		0,
		usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens,
	);

	return (
		(billableInputTokens / 1_000_000) * inputPrice +
		(usage.outputTokens / 1_000_000) * outputPrice +
		(usage.cacheReadTokens / 1_000_000) * cacheReadPrice +
		(usage.cacheWriteTokens / 1_000_000) * cacheWritePrice
	);
}

/**
 * Normalizes usage from various provider formats into a standard structure.
 * Accepts both AI SDK's normalized shapes (AiSdkStreamTotalUsage, AiSdkStreamUsage)
 * and raw provider responses. Handles multiple naming conventions (camelCase vs snake_case),
 * extracts costs from provider-specific fields, and falls back to pricing-based calculation.
 * Provider-reported billed cost takes precedence over market cost so gateway discounts
 * are reflected in user-facing totals. Market cost remains a fallback when no billed
 * cost is available.
 *
 * @param usageValue - AI SDK normalized usage or raw provider response object
 * @param providerMetadata - Provider-specific metadata for cost extraction
 * @param pricingValue - Fallback pricing config (per 1M tokens) when no explicit cost found
 */
export function normalizeUsage(
	usageValue:
		| AiSdkStreamUsage
		| AiSdkStreamTotalUsage
		| Record<string, unknown>
		| undefined,
	providerMetadata?: unknown,
	pricingValue?: unknown,
): GatewayNormalizedUsage {
	const usage =
		usageValue && typeof usageValue === "object"
			? (usageValue as Record<string, unknown>)
			: {};
	const providerUsage = extractProviderNestedUsage(providerMetadata);
	const providerMetadataRecord =
		providerMetadata && typeof providerMetadata === "object"
			? (providerMetadata as Record<string, unknown>)
			: {};
	const gatewayMetadata =
		providerMetadataRecord.gateway &&
		typeof providerMetadataRecord.gateway === "object"
			? (providerMetadataRecord.gateway as Record<string, unknown>)
			: {};
	const rawUsage =
		usage.raw && typeof usage.raw === "object"
			? (usage.raw as Record<string, unknown>)
			: usage;
	const upstreamInferenceCost =
		getNumericValue(
			(rawUsage.cost_details as Record<string, unknown> | undefined)
				?.upstream_inference_cost,
		) ?? getNumericValue(rawUsage.upstream_inference_cost);
	const marketCost =
		getNumericValue(rawUsage.market_cost) ??
		getNumericValue(rawUsage.marketCost) ??
		getNumericValue(gatewayMetadata.marketCost);
	const baseCost =
		getNumericValue(rawUsage.cost) ?? getNumericValue(gatewayMetadata.cost);
	const hasExplicitCost =
		marketCost !== undefined ||
		baseCost !== undefined ||
		upstreamInferenceCost !== undefined;
	const isByokUsage =
		rawUsage.is_byok === true ||
		rawUsage.isByok === true ||
		gatewayMetadata.is_byok === true ||
		gatewayMetadata.isByok === true;
	const shouldAddUpstreamCost =
		isByokUsage &&
		baseCost !== undefined &&
		upstreamInferenceCost !== undefined;
	const costOrUpstream =
		baseCost !== undefined && baseCost > 0
			? baseCost
			: (upstreamInferenceCost ?? baseCost);
	const billedCost = shouldAddUpstreamCost
		? baseCost + upstreamInferenceCost
		: costOrUpstream;
	const totalCost =
		billedCost !== undefined && billedCost !== 0
			? billedCost
			: (marketCost ?? billedCost);
	const normalizedUsage = {
		inputTokens:
			getNestedUsageValue(usage, "inputTokens", "total") ||
			getUsageValue(usage, "inputTokens", "input_tokens", "prompt_tokens") ||
			getUsageValue(rawUsage, "promptTokenCount", "prompt_token_count"),
		outputTokens:
			getNestedUsageValue(usage, "outputTokens", "total") ||
			getUsageValue(
				usage,
				"outputTokens",
				"output_tokens",
				"completion_tokens",
			) ||
			getUsageValue(rawUsage, "candidatesTokenCount", "candidates_token_count"),
		cacheReadTokens:
			getNestedUsageValue(usage, "inputTokens", "cacheRead") ||
			getNestedUsageValue(usage, "inputTokenDetails", "cacheReadTokens") ||
			getUsageValue(
				usage,
				"cachedInputTokens",
				"cacheReadTokens",
				"cache_read_tokens",
				"cache_read_input_tokens",
			) ||
			getNestedUsageValue(usage, "prompt_tokens_details", "cached_tokens") ||
			getNestedUsageValue(rawUsage, "prompt_tokens_details", "cached_tokens") ||
			getUsageValue(rawUsage, "cachedContentTokenCount") ||
			getUsageValue(
				providerUsage ?? {},
				"cachedInputTokens",
				"cacheReadTokens",
				"cache_read_tokens",
				"cache_read_input_tokens",
			),
		cacheWriteTokens:
			getNestedUsageValue(usage, "inputTokens", "cacheWrite") ||
			getNestedUsageValue(usage, "inputTokenDetails", "cacheWriteTokens") ||
			getNestedUsageValue(
				usage,
				"prompt_tokens_details",
				"cache_write_tokens",
			) ||
			getUsageValue(
				usage,
				"cacheWriteTokens",
				"cache_write_tokens",
				"cache_creation_input_tokens",
			) ||
			getNestedUsageValue(
				rawUsage,
				"prompt_tokens_details",
				"cache_write_tokens",
			) ||
			getUsageValue(
				rawUsage,
				"cacheWriteTokens",
				"cache_write_tokens",
				"cache_creation_input_tokens",
			) ||
			getUsageValue(
				providerUsage ?? {},
				"cacheWriteTokens",
				"cache_write_tokens",
				"cache_creation_input_tokens",
			),
	};
	const reasoningTokenCount = firstUsageValue(
		[usage, rawUsage, providerUsage ?? {}],
		REASONING_TOKEN_PATHS,
	);
	const resolvedTotalCost =
		totalCost !== undefined
			? totalCost
			: hasExplicitCost
				? undefined
				: calculateUsageCostFromPricing(normalizedUsage, pricingValue);

	return {
		...normalizedUsage,
		...(reasoningTokenCount > 0 ? { reasoningTokenCount } : {}),
		...(typeof resolvedTotalCost === "number"
			? { totalCost: resolvedTotalCost }
			: {}),
	};
}

/**
 * Some Pliny models (and other OpenAI-compatible backends) omit `usage`
 * entirely, or return an all-zero object, on otherwise successful
 * completions. Fill in a char-based estimate so the UI still shows non-zero
 * tokens/context usage instead of nothing, flagged `estimated: true` so
 * callers can render a "~" prefix rather than presenting it as exact.
 * Cost is deliberately left unset here: an estimated token count times a
 * real price would look like a precise dollar figure it is not.
 */
export function applyUsageEstimateFallback(
	usage: GatewayNormalizedUsage,
	request: Pick<GatewayStreamRequest, "systemPrompt" | "messages" | "tools">,
	outputText: string | undefined,
): GatewayNormalizedUsage {
	const hasRealUsage =
		usage.inputTokens > 0 ||
		usage.outputTokens > 0 ||
		usage.cacheReadTokens > 0 ||
		usage.cacheWriteTokens > 0;
	if (hasRealUsage) {
		return usage;
	}
	return {
		...usage,
		inputTokens: estimateRequestInputTokens(request),
		outputTokens: outputText ? estimateTokens(outputText.length) : 0,
		estimated: true,
	};
}
