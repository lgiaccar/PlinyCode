import type {
	ModelCapability,
	ModelInfo,
	ModelPricing,
} from "../catalog/types";
import catalog from "./data/pliny-models.json";

export const PLINY_BASE_URL = process.env.PLINY_BASE_URL ?? catalog.baseURL;

/**
 * Virtual "FreeAuto" router model. It is never sent to the gateway: the host
 * intercepts it (see the extension's `agentModelFactory`) and delegates each
 * call to a concrete free model chosen from the user's rules file. It exists in
 * the catalog so the picker can show it and so context/compaction budgets have
 * a `ModelInfo` to read.
 */
export const PLINY_FREE_AUTO_MODEL_ID = "pliny/auto-free";

/**
 * Virtual "BalanceAuto" router model. Like FreeAuto it is never sent to the
 * gateway, but its rules may route to paid hosted models: high-end models take
 * the difficult work, cheaper or free ones the simple work and sub-agent runs.
 * It only appears in the picker when paid models are unlocked.
 */
export const PLINY_BALANCE_AUTO_MODEL_ID = "pliny/auto-paid-balanced";

/** FreeAuto id prefix before the `auto-*` rename (`pliny/free-auto[-<profile>]`). */
const LEGACY_FREE_AUTO_MODEL_ID = "pliny/free-auto";
/** BalanceAuto id before the `auto-*` rename. */
const LEGACY_BALANCE_AUTO_MODEL_ID = "pliny/balance-auto";

/**
 * Map a router id from before the `auto-*` rename (`pliny/free-auto`,
 * `pliny/free-auto-fast`, `pliny/balance-auto`, ...) onto its current id.
 * Every other id is returned unchanged. Saved selections, agent configs and
 * rules files written before the rename keep working through this.
 */
export function canonicalPlinyModelId(modelId: string): string {
	if (modelId === LEGACY_FREE_AUTO_MODEL_ID) {
		return PLINY_FREE_AUTO_MODEL_ID;
	}
	if (modelId.startsWith(`${LEGACY_FREE_AUTO_MODEL_ID}-`)) {
		return `${PLINY_FREE_AUTO_MODEL_ID}${modelId.slice(LEGACY_FREE_AUTO_MODEL_ID.length)}`;
	}
	if (modelId === LEGACY_BALANCE_AUTO_MODEL_ID) {
		return PLINY_BALANCE_AUTO_MODEL_ID;
	}
	return modelId;
}

/**
 * Router profiles. Each is its own virtual id with its own rules file, so
 * different routing strategies can be picked per task and compared side by
 * side. The `free` family (`pliny/auto-free[-<profile>]`) only ever routes to
 * free self-hosted models; the `balance` family may also use paid ones.
 */
export const PLINY_ROUTER_PROFILES = [
	{
		profile: "default",
		id: PLINY_FREE_AUTO_MODEL_ID,
		family: "free",
		name: "auto-free (router)",
		label: "auto-free",
		description:
			"Routes each call to the best free self-hosted Pliny model and fails over automatically",
	},
	{
		profile: "fast",
		id: `${PLINY_FREE_AUTO_MODEL_ID}-fast`,
		family: "free",
		name: "auto-free-fast (router)",
		label: "auto-free-fast",
		description:
			"FreeAuto tuned for latency: fastest models first, reasoning off wherever it can be",
	},
	{
		profile: "smart",
		id: `${PLINY_FREE_AUTO_MODEL_ID}-smart`,
		family: "free",
		name: "auto-free-smart (router)",
		label: "auto-free-smart",
		description:
			"FreeAuto with a small classifier that picks the model tier and whether to think, once per turn",
	},
	{
		profile: "balance",
		id: PLINY_BALANCE_AUTO_MODEL_ID,
		family: "balance",
		name: "auto-paid-balanced (router)",
		label: "auto-paid-balanced",
		description:
			"Paid high-end models for difficult work, cheaper or free models for simple requests and sub-agents",
	},
] as const;

export type PlinyRouterProfileSpec = (typeof PLINY_ROUTER_PROFILES)[number];
export type PlinyRouterProfile = PlinyRouterProfileSpec["profile"];
export type PlinyRouterFamily = PlinyRouterProfileSpec["family"];

/** The free-only profiles (`pliny/auto-free[-<profile>]`). */
export const PLINY_FREE_AUTO_PROFILES = PLINY_ROUTER_PROFILES.filter(
	(entry) => entry.family === "free",
);

export type PlinyFreeAutoProfile =
	(typeof PLINY_FREE_AUTO_PROFILES)[number]["profile"];

/** The virtual id for a FreeAuto profile. */
export function plinyFreeAutoModelId(profile: string): string {
	return profile === "default"
		? PLINY_FREE_AUTO_MODEL_ID
		: `${PLINY_FREE_AUTO_MODEL_ID}-${profile}`;
}

/** The virtual id for any router profile; unknown names are read as FreeAuto profiles. */
export function plinyRouterModelId(profile: string): string {
	return (
		PLINY_ROUTER_PROFILES.find((entry) => entry.profile === profile)?.id ??
		plinyFreeAutoModelId(profile)
	);
}

/** The definition of a built-in router profile, by name. */
export function plinyRouterProfileSpec(
	profile: string,
): PlinyRouterProfileSpec | undefined {
	return PLINY_ROUTER_PROFILES.find((entry) => entry.profile === profile);
}

/** True for a profile whose rules may route to paid hosted models. */
export function plinyRouterProfileAllowsPaid(profile: string): boolean {
	return plinyRouterProfileSpec(profile)?.family === "balance";
}

/**
 * Concrete model used whenever the virtual router id reaches a code path that
 * must talk to the gateway directly (commit messages, compaction summaries).
 */
export const PLINY_FREE_AUTO_FALLBACK_MODEL_ID = "snps-provider/kimi-k2.6";

export const PLINY_DEFAULT_MODEL_ID = PLINY_FREE_AUTO_MODEL_ID;
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

/** Request field that turns reasoning off on a model that reasons by default. */
export type PlinyThinkingOff =
	| "template-kwargs"
	| "reasoning-effort-none"
	| "reasoning-exclude";

/** Request field that turns reasoning on for a model that is off by default. */
export type PlinyThinkingOn = "reasoning-effort" | "template-kwargs";

/**
 * Measured reasoning behaviour of a self-hosted model, copied from the
 * thinking probe (`scripts/probe-pliny-free-models.ts --thinking`). A model
 * without an entry has not been measured, and nothing is sent to change its
 * reasoning: an unsupported field is rejected by the gateway, failing the call.
 */
export type PlinyThinkingControls = {
	defaultOn: boolean;
	off?: PlinyThinkingOff;
	on?: PlinyThinkingOn;
};

type PlinyCatalogEntry = {
	id: string;
	context?: number;
	tool_call?: boolean;
	attachment?: boolean;
	cache_control?: boolean;
	auto_cache?: boolean;
	note?: string;
	thinking?: PlinyThinkingControls;
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
	if (entry.thinking && plinyCanThink(entry.thinking)) {
		capabilities.add("reasoning");
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
		// No `family`: lineage routing (Claude cache/thinking) reads the family
		// before the model id, so a hosting label here hid every Claude model.
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

/** Prefix shared by every free, self-hosted Pliny pool. */
const PLINY_SELF_HOSTED_PREFIX = "snps-provider";

/** True for free self-hosted Pliny model ids (all `snps-provider*` pools). */
export function isPlinySelfHostedModelId(modelId: string): boolean {
	return modelId.startsWith(PLINY_SELF_HOSTED_PREFIX);
}

/** True for the virtual FreeAuto id and every profile id derived from it. */
export function isPlinyFreeAutoModelId(modelId: string): boolean {
	const id = canonicalPlinyModelId(modelId);
	return (
		id === PLINY_FREE_AUTO_MODEL_ID ||
		id.startsWith(`${PLINY_FREE_AUTO_MODEL_ID}-`)
	);
}

/** True for the virtual BalanceAuto id. */
export function isPlinyBalanceAutoModelId(modelId: string): boolean {
	return canonicalPlinyModelId(modelId) === PLINY_BALANCE_AUTO_MODEL_ID;
}

/** True for every virtual router id: the FreeAuto profiles and BalanceAuto. */
export function isPlinyRouterModelId(modelId: string): boolean {
	return isPlinyFreeAutoModelId(modelId) || isPlinyBalanceAutoModelId(modelId);
}

/** The profile a FreeAuto id selects (`"default"` for the bare id). */
export function plinyFreeAutoProfile(modelId: string): string {
	const id = canonicalPlinyModelId(modelId);
	return id.startsWith(`${PLINY_FREE_AUTO_MODEL_ID}-`)
		? id.slice(PLINY_FREE_AUTO_MODEL_ID.length + 1)
		: "default";
}

/** The profile any router id selects: `"balance"` for BalanceAuto, else the FreeAuto profile. */
export function plinyRouterProfile(modelId: string): string {
	return isPlinyBalanceAutoModelId(modelId)
		? "balance"
		: plinyFreeAutoProfile(modelId);
}

const THINKING_BY_MODEL_ID = new Map(
	(catalog.selfHosted as PlinyCatalogEntry[])
		.filter((entry) => entry.thinking)
		.map((entry) => [entry.id, entry.thinking as PlinyThinkingControls]),
);

/**
 * Whether a request can get this model to reason: it does so by default, or
 * `reasoning_effort` switches it on. A chat-template-only on-switch does not
 * count: the gateway sends reasoning intent as `reasoning_effort`, never as
 * `chat_template_kwargs`.
 */
export function plinyCanThink(controls: PlinyThinkingControls): boolean {
	return controls.defaultOn || controls.on === "reasoning-effort";
}

/** Measured reasoning controls for a self-hosted model, when it was probed. */
export function plinyThinkingControls(
	modelId: string,
): PlinyThinkingControls | undefined {
	return THINKING_BY_MODEL_ID.get(modelId);
}

/**
 * True for anything that costs nothing to run: the free self-hosted models and
 * the router, which only ever delegates to them.
 */
export function isPlinyFreeModelId(modelId: string): boolean {
	return isPlinyFreeAutoModelId(modelId) || isPlinySelfHostedModelId(modelId);
}

/**
 * Map a model id onto one the gateway can actually resolve. Only the virtual
 * router ids are rewritten; every other id is returned unchanged. BalanceAuto
 * maps onto the same free fallback: the callers are utility jobs (commit
 * messages) that are simple by nature, so they get the cheap model.
 */
export function resolvePlinyConcreteModelId(
	modelId: string | undefined,
	fallbackModelId: string = PLINY_FREE_AUTO_FALLBACK_MODEL_ID,
): string {
	return modelId && isPlinyRouterModelId(modelId)
		? fallbackModelId
		: (modelId ?? fallbackModelId);
}

/**
 * The free pool, ordered as the catalog lists it (largest context first within
 * each tier). Only tool-call-capable self-hosted entries are eligible; the
 * catalog's `noToolCall` / `knownBroken` ids never appear here because they are
 * not listed under `selfHosted`.
 */
export function plinyFreePoolIds(): string[] {
	return (catalog.selfHosted as PlinyCatalogEntry[])
		.filter((entry) => entry.tool_call)
		.map((entry) => entry.id);
}

/**
 * The paid hosted models a BalanceAuto rules file may route to, in catalog
 * order. Only tool-call-capable entries are eligible.
 */
export function plinyHostedPoolIds(): string[] {
	return (catalog.hosted as PlinyCatalogEntry[])
		.filter((entry) => entry.tool_call)
		.map((entry) => entry.id);
}

/**
 * `ModelInfo` for the virtual router. The context window is deliberately the
 * 256k tier rather than GLM-5.2's 512k: it is the window a majority of the pool
 * can honor, so compaction budgets stay valid whichever model a call lands on,
 * while the policy can still route a genuinely huge request to GLM-5.2.
 */
function buildFreeAutoModelInfo(profile: PlinyRouterProfileSpec): ModelInfo {
	return {
		id: profile.id,
		name: profile.name,
		description: profile.description,
		contextWindow: 256_000,
		maxInputTokens: 256_000,
		maxTokens: 32_768,
		capabilities: ["streaming", "tools"],
		family: "pliny-router",
		// Routes only to free self-hosted models.
		pricing: SELF_HOSTED_PRICING,
		metadata: {
			provider: "pliny",
			pool: null,
			selfHosted: true,
			router: true,
			routerProfile: profile.profile,
		},
	};
}

/**
 * `ModelInfo` for BalanceAuto. The window is the hosted default: the paid
 * models it prefers are budgeted at 200k, and a request beyond that is routed
 * to a large-context free model by the rules. It declares image input because
 * the hosted Claude models it routes to accept images; a request with images
 * only ever goes to a model that declares them. No pricing is stamped on the
 * virtual id: every call is billed at the concrete model it lands on.
 */
function buildBalanceAutoModelInfo(profile: PlinyRouterProfileSpec): ModelInfo {
	return {
		id: profile.id,
		name: profile.name,
		description: profile.description,
		contextWindow: HOSTED_DEFAULT_CONTEXT,
		maxInputTokens: HOSTED_DEFAULT_CONTEXT,
		maxTokens: 32_768,
		capabilities: ["streaming", "tools", "images"],
		family: "pliny-router",
		metadata: {
			provider: "pliny",
			pool: null,
			selfHosted: false,
			router: true,
			routerProfile: profile.profile,
			paid: true,
		},
	};
}

/**
 * Static Pliny catalog from live probes (`research/pliny-models.json`).
 * Never derive the picker from the gateway `/models` endpoint.
 */
export function buildPlinyModels(): Record<string, ModelInfo> {
	const models: Record<string, ModelInfo> = {};

	// First so the router profiles head the picker list: the free ones, then
	// BalanceAuto, which the picker only shows once paid models are unlocked.
	for (const profile of PLINY_ROUTER_PROFILES) {
		const info =
			profile.family === "balance"
				? buildBalanceAutoModelInfo(profile)
				: buildFreeAutoModelInfo(profile);
		models[info.id] = info;
	}

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
