import type { ModelCapability, ModelInfo, ModelPricing } from "../catalog/types";
import catalog from "./data/pliny-models.json";

export const PLINY_BASE_URL = process.env.PLINY_BASE_URL ?? catalog.baseURL;
export const PLINY_DEFAULT_MODEL_ID = "snps-provider/kimi-k2.6";
export const PLINY_DEFAULT_HEADERS = catalog.headers as Readonly<
	Record<string, string>
>;
export const PLINY_TIMEOUT_MS = catalog.timeouts.timeout;

/** selfHosted pools run on internal capacity with no per-token charge. */
const SELF_HOSTED_PRICING: ModelPricing = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

type PlinyCatalogEntry = {
	id: string;
	context?: number;
	tool_call?: boolean;
	attachment?: boolean;
	cache_control?: boolean;
	auto_cache?: boolean;
	note?: string;
	/** USD per 1M tokens. Absent when no confirmed price is known — never guess a number here. */
	pricing?: ModelPricing;
	/** Provenance for `pricing`, e.g. flags a public-list-price stand-in vs a confirmed internal figure. */
	priceSource?: string;
};

const HOSTED_DEFAULT_CONTEXT = 200_000;
const HOSTED_DEFAULT_MAX_OUTPUT = 64_000;

function displayName(id: string): string {
	const slash = id.lastIndexOf("/");
	const leaf = slash >= 0 ? id.slice(slash + 1) : id;
	return leaf.replace(/[-_.]+/g, " ");
}

function poolLabel(id: string): string | undefined {
	const slash = id.indexOf("/");
	if (slash < 0) {
		return undefined;
	}
	return id.slice(0, slash);
}

function toModelInfo(entry: PlinyCatalogEntry, selfHosted: boolean): ModelInfo {
	const contextWindow = entry.context ?? HOSTED_DEFAULT_CONTEXT;
	const capabilities = new Set<ModelCapability>(["streaming", "tools"]);
	if (entry.attachment) {
		capabilities.add("images");
	}
	if (entry.cache_control || entry.auto_cache) {
		capabilities.add("prompt-cache");
	}

	const pool = poolLabel(entry.id);
	const descriptionParts = [
		selfHosted ? "Self-hosted via Pliny" : "Hosted via Pliny",
		pool ? `pool: ${pool}` : undefined,
		entry.note,
	].filter(Boolean);

	const pricing = selfHosted ? SELF_HOSTED_PRICING : entry.pricing;

	return {
		id: entry.id,
		name: displayName(entry.id),
		description: descriptionParts.join(" · "),
		contextWindow,
		maxInputTokens: contextWindow,
		maxTokens: selfHosted
			? Math.min(Math.floor(contextWindow / 4), 65_536)
			: HOSTED_DEFAULT_MAX_OUTPUT,
		capabilities: [...capabilities],
		family: selfHosted ? "pliny-self-hosted" : "pliny-hosted",
		...(pricing ? { pricing } : {}),
		metadata: {
			provider: "pliny",
			pool: pool ?? null,
			selfHosted,
			...(entry.cache_control ? { cacheControl: true } : {}),
			...(entry.auto_cache ? { autoCache: true } : {}),
			...(!selfHosted && entry.priceSource
				? { priceSource: entry.priceSource }
				: {}),
		},
	};
}

/**
 * Static Pliny catalog from live probes (`research/pliny-models.json`).
 * Never derive the picker from the gateway `/models` endpoint.
 */
export function buildPlinyModels(): Record<string, ModelInfo> {
	const models: Record<string, ModelInfo> = {};

	for (const entry of catalog.selfHosted as PlinyCatalogEntry[]) {
		if (!entry.tool_call) {
			continue;
		}
		models[entry.id] = toModelInfo(entry, true);
	}

	for (const entry of catalog.hosted as PlinyCatalogEntry[]) {
		if (!entry.tool_call) {
			continue;
		}
		models[entry.id] = toModelInfo(entry, false);
	}

	return models;
}
