/**
 * Router tuning the user sets in Settings → Router: per router profile, a
 * priority-ordered model list and overrides for every knob of the routing
 * rules. Stored as one map (`routerTuning` in global state) and laid over the
 * rules files by the router (`src/sdk/router/router-tuning.ts`), so only the
 * fields set here change anything. Model ids are checked there too: a FreeAuto
 * profile drops paid ids however they got in.
 */

import { canonicalPlinyModelId, isPlinyBalanceAutoModelId, isPlinyFreeAutoModelId, PLINY_FREE_AUTO_MODEL_ID } from "./pliny"

/** The router profiles Settings can tune, in the order the picker shows them. */
export const ROUTER_TUNING_PROFILES = ["fast", "default", "smart", "balance"] as const
export type RouterTuningProfile = (typeof ROUTER_TUNING_PROFILES)[number]

/** Most models one ordered list may hold: the point is a short list the router really uses. */
export const ROUTER_TUNING_MAX_MODELS = 6

/** The routes the model order applies to; the others keep their own lists unless overridden. */
export const ROUTER_MAIN_ROUTES = ["default", "coding", "plan-and-reasoning", "ask-reasoning"] as const

/** `default` clears a route's effort, so each model keeps its own default. */
const ROUTER_TUNING_EFFORTS = ["quick", "think", "default"] as const
export type RouterTuningEffort = (typeof ROUTER_TUNING_EFFORTS)[number]

const ROUTER_TUNING_REASONING_EFFORTS = ["low", "medium", "high"] as const
export type RouterTuningReasoningEffort = (typeof ROUTER_TUNING_REASONING_EFFORTS)[number]

export interface RouterRouteTuning {
	/** Replaces the route's candidate list, best first. */
	use?: string[]
	effort?: RouterTuningEffort
	reasoningEffort?: RouterTuningReasoningEffort
	minEstimatedTokens?: number
	maxEstimatedTokens?: number
	maxPromptChars?: number
}

/** How a compaction size is expressed: a share in percent, or a token count. */
export const ROUTER_COMPACTION_UNITS = ["percent", "tokens"] as const
export type RouterCompactionUnit = (typeof ROUTER_COMPACTION_UNITS)[number]

export interface RouterCompactionSize {
	unit: RouterCompactionUnit
	value: number
}

export interface RouterCompactionTuning {
	/**
	 * The input budget compaction runs against (it starts at the
	 * `plinycode.compaction.threshold` share of it): a percentage of the
	 * router's compiled budget, or tokens.
	 */
	budget?: RouterCompactionSize
	/** The size a compaction shrinks the request to: a percentage of the budget, or tokens. */
	target?: RouterCompactionSize
}

export interface RouterProfileTuning {
	/** The model order: the main routes' list and the head of the pool. */
	models?: string[]
	/** Route only to `models` and the routes' own overrides, with no fallback to the rest of the catalog. */
	exclusive?: boolean
	/** Overrides per route name. */
	routes?: Record<string, RouterRouteTuning>
	classifier?: { enabled?: boolean; timeoutMs?: number }
	guard?: { judge?: boolean; judgeTimeoutMs?: number }
	health?: {
		cooldownMs?: number
		failuresBeforeCooldown?: number
		maxFailoversPerTurn?: number
		firstTokenTimeoutMs?: number
		stallTimeoutMs?: number
	}
	escalation?: { afterStalls?: number; afterFailedCommands?: number; maxNudgesPerRun?: number }
	utility?: { classifier?: string; judge?: string; summarizer?: string; commit?: string }
	sticky?: boolean
	contextMarginRatio?: number
	/** When the conversation is compacted, and to what size, in place of the router's compiled budget. */
	compaction?: RouterCompactionTuning
}

export type RouterTuningMap = Partial<Record<RouterTuningProfile, RouterProfileTuning>>

/** One model the Router settings may offer for a profile. */
export interface RouterModelOption {
	id: string
	name: string
	free: boolean
	contextWindow?: number
	/** Output tokens the size filter keeps free in the window: the model's maxTokens. */
	outputReserve?: number
	images?: boolean
}

/** A route as the rules files define it, shown as the default an override replaces. */
export interface RouterRouteView {
	name: string
	use: string[]
	effort?: "quick" | "think"
	reasoningEffort?: RouterTuningReasoningEffort
	minEstimatedTokens?: number
	maxEstimatedTokens?: number
	maxPromptChars?: number
}

/** The rules a profile has without any Settings tuning: the defaults the form shows. */
export interface RouterBaseView {
	models: string[]
	routes: RouterRouteView[]
	classifier: { enabled: boolean; timeoutMs: number }
	guard: { judge: boolean; judgeTimeoutMs: number }
	health: {
		cooldownMs: number
		failuresBeforeCooldown: number
		maxFailoversPerTurn: number
		firstTokenTimeoutMs: number
		stallTimeoutMs: number
	}
	escalation: { afterStalls: number; afterFailedCommands: number; maxNudgesPerRun: number }
	utility: { classifier: string; judge: string; summarizer: string; commit: string }
	sticky: boolean
	contextMarginRatio: number
}

export interface RouterProfileView {
	profile: RouterTuningProfile
	label: string
	modelId: string
	/** The compiled compaction budget in tokens (plinyRouterBudget): what a percentage budget is of. */
	compactionBudget: number
	base: RouterBaseView
	tuning: RouterProfileTuning
	candidates: RouterModelOption[]
}

/** What `getRouterSettings` and `setRouterTuning` return. */
export interface RouterSettingsView {
	profiles: RouterProfileView[]
}

export function isRouterTuningProfile(value: unknown): value is RouterTuningProfile {
	return typeof value === "string" && (ROUTER_TUNING_PROFILES as readonly string[]).includes(value)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
	const number = positive(value)
	return number === undefined ? undefined : Math.max(1, Math.round(number))
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
}

function modelId(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function modelIds(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined
	}
	const ids = [...new Set(value.map(modelId).filter((id): id is string => id !== undefined))]
	return ids.length > 0 ? ids.slice(0, ROUTER_TUNING_MAX_MODELS) : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Keeps the fields that are set; undefined when none is. */
function compact<T extends object>(value: T): T | undefined {
	const entries = Object.entries(value).filter(([, field]) => field !== undefined)
	return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined
}

function normalizeRoute(value: unknown): RouterRouteTuning | undefined {
	const raw = record(value)
	if (!raw) {
		return undefined
	}
	return compact<RouterRouteTuning>({
		use: modelIds(raw.use),
		effort: oneOf(raw.effort, ROUTER_TUNING_EFFORTS),
		reasoningEffort: oneOf(raw.reasoningEffort, ROUTER_TUNING_REASONING_EFFORTS),
		minEstimatedTokens: positiveInteger(raw.minEstimatedTokens),
		maxEstimatedTokens: positiveInteger(raw.maxEstimatedTokens),
		maxPromptChars: positiveInteger(raw.maxPromptChars),
	})
}

function normalizeRoutes(value: unknown): Record<string, RouterRouteTuning> | undefined {
	const raw = record(value)
	if (!raw) {
		return undefined
	}
	const routes: Record<string, RouterRouteTuning> = {}
	for (const [name, entry] of Object.entries(raw)) {
		const route = /^[\w-]{1,64}$/.test(name) ? normalizeRoute(entry) : undefined
		if (route) {
			routes[name] = route
		}
	}
	return Object.keys(routes).length > 0 ? routes : undefined
}

function normalizeCompactionSize(value: unknown): RouterCompactionSize | undefined {
	const raw = record(value)
	const unit = oneOf(raw?.unit, ROUTER_COMPACTION_UNITS)
	const size = positive(raw?.value)
	if (!unit || size === undefined) {
		return undefined
	}
	// Percentages keep one decimal; token counts are whole.
	return { unit, value: unit === "percent" ? Math.round(size * 10) / 10 : Math.max(1, Math.round(size)) }
}

function normalizeCompaction(value: unknown): RouterCompactionTuning | undefined {
	const raw = record(value)
	if (!raw) {
		return undefined
	}
	return compact<RouterCompactionTuning>({
		budget: normalizeCompactionSize(raw.budget),
		target: normalizeCompactionSize(raw.target),
	})
}

/**
 * A size in tokens: a percentage of `base`, or the token count itself.
 * Undefined when the size is unset.
 */
export function compactionSizeTokens(size: RouterCompactionSize | undefined, base: number): number | undefined {
	if (!size) {
		return undefined
	}
	return Math.round(size.unit === "percent" ? (size.value / 100) * base : size.value)
}

/**
 * A profile's compaction tuning in tokens. `defaultBudget` is the router's
 * compiled budget (`plinyRouterBudget`): the budget's percentage is of it, and
 * the target's of the budget as tuned. Undefined fields keep the compiled
 * budget and the engine's adaptive target. Out-of-range values are kept: the
 * Settings page warns about them, and the engine never lets the target reach
 * the trigger.
 */
export function resolveRouterCompaction(
	tuning: RouterCompactionTuning | undefined,
	defaultBudget: number,
): { budgetTokens?: number; targetTokens?: number } {
	const budgetTokens = compactionSizeTokens(tuning?.budget, defaultBudget)
	const targetTokens = compactionSizeTokens(tuning?.target, budgetTokens ?? defaultBudget)
	return {
		...(budgetTokens !== undefined ? { budgetTokens } : {}),
		...(targetTokens !== undefined ? { targetTokens } : {}),
	}
}

/** Smallest size compaction can reliably reach: it always keeps the recent messages. */
const MIN_COMPACTION_TOKENS = 8_000

export interface RouterCompactionNote {
	level: "info" | "warning"
	text: string
}

function kTokens(tokens: number): string {
	return tokens >= 10_000 ? `${Math.round(tokens / 1000)}k` : tokens.toLocaleString("en-US")
}

/**
 * What Settings → Router says about a compaction budget and target: which
 * models of the order hand a request on before compaction starts, and sizes
 * that cannot work as meant. Notes only: every value still saves. A model's
 * limit is what the size filter lets through, in its own tokens: its window
 * less its output reserve, over the context margin.
 */
export function routerCompactionNotes(input: {
	budgetTokens: number
	targetTokens?: number
	threshold: number
	margin: number
	models: Pick<RouterModelOption, "name" | "contextWindow" | "outputReserve">[]
}): RouterCompactionNote[] {
	const notes: RouterCompactionNote[] = []
	const trigger = Math.round(input.budgetTokens * input.threshold)
	const limits = input.models
		.filter((model) => model.contextWindow && model.contextWindow > 0)
		.map((model) => ({
			name: model.name,
			limit: Math.floor(((model.contextWindow ?? 0) - (model.outputReserve ?? 0)) / input.margin),
		}))
	const dropped = limits.filter((model) => model.limit < trigger)
	const fits = limits.filter((model) => model.limit >= trigger)
	if (input.budgetTokens < MIN_COMPACTION_TOKENS) {
		notes.push({ level: "warning", text: "So small a budget compacts on almost every call." })
	}
	if (limits.length > 0 && fits.length === 0) {
		const largest = Math.max(...limits.map((model) => model.limit))
		notes.push({
			level: "warning",
			text: `No model in this order fits a ${kTokens(trigger)} request (the largest takes about ${kTokens(largest)}): past that, requests go to them anyway and may be rejected.`,
		})
	} else if (dropped.length > 0) {
		const handedOff = dropped.map((model) => `${model.name} (~${kTokens(model.limit)})`).join(", ")
		notes.push({
			level: "info",
			text: `Compaction starts at about ${kTokens(trigger)}. Before that, larger requests move from ${handedOff} to ${fits[0]?.name}.`,
		})
	}
	if (input.targetTokens !== undefined) {
		if (input.targetTokens >= trigger) {
			notes.push({
				level: "warning",
				text: `At or above the ${kTokens(trigger)} trigger: compaction shrinks to just under the trigger instead.`,
			})
		} else if (input.targetTokens < MIN_COMPACTION_TOKENS) {
			notes.push({
				level: "warning",
				text: `Below ${kTokens(MIN_COMPACTION_TOKENS)}: compaction keeps the recent messages, so it may not get this small.`,
			})
		}
	}
	return notes
}

/** The Settings → Router profile of a router model id, or undefined for any other model. */
export function routerTuningProfileFor(modelId: string | undefined): RouterTuningProfile | undefined {
	if (isPlinyBalanceAutoModelId(modelId)) {
		return "balance"
	}
	if (!modelId || !isPlinyFreeAutoModelId(modelId)) {
		return undefined
	}
	const suffix = canonicalPlinyModelId(modelId).slice(PLINY_FREE_AUTO_MODEL_ID.length + 1)
	return suffix ? (isRouterTuningProfile(suffix) ? suffix : undefined) : "default"
}

/**
 * A router model's info with its tuned compaction budget as `maxInputTokens`,
 * so what the context bar marks agrees with when the engine compacts. Any
 * other model, or a router without a tuned budget, is returned unchanged.
 */
export function withRouterCompactionBudget<T extends { maxInputTokens?: number }>(
	info: T | undefined,
	modelId: string | undefined,
	tuningMap: unknown,
): T | undefined {
	const profile = routerTuningProfileFor(modelId)
	if (!info || !profile || info.maxInputTokens === undefined) {
		return info
	}
	const { budgetTokens } = resolveRouterCompaction(normalizeRouterTuning(tuningMap)[profile]?.compaction, info.maxInputTokens)
	return budgetTokens === undefined ? info : { ...info, maxInputTokens: budgetTokens }
}

/** A stored profile tuning with every invalid field dropped; undefined when nothing is left. */
export function normalizeRouterProfileTuning(value: unknown): RouterProfileTuning | undefined {
	const raw = record(value)
	if (!raw) {
		return undefined
	}
	const classifier = record(raw.classifier) ?? {}
	const guard = record(raw.guard) ?? {}
	const health = record(raw.health) ?? {}
	const escalation = record(raw.escalation) ?? {}
	const utility = record(raw.utility) ?? {}
	const models = modelIds(raw.models)
	// Below 1 the margin would let through a request that cannot fit.
	const margin = positive(raw.contextMarginRatio)
	return compact<RouterProfileTuning>({
		models,
		// Without a model order there is nothing to be exclusive to.
		exclusive: models && raw.exclusive === true ? true : undefined,
		routes: normalizeRoutes(raw.routes),
		classifier: compact({
			enabled: typeof classifier.enabled === "boolean" ? classifier.enabled : undefined,
			timeoutMs: positiveInteger(classifier.timeoutMs),
		}),
		guard: compact({
			judge: typeof guard.judge === "boolean" ? guard.judge : undefined,
			judgeTimeoutMs: positiveInteger(guard.judgeTimeoutMs),
		}),
		health: compact({
			cooldownMs: positiveInteger(health.cooldownMs),
			failuresBeforeCooldown: positiveInteger(health.failuresBeforeCooldown),
			maxFailoversPerTurn: positiveInteger(health.maxFailoversPerTurn),
			firstTokenTimeoutMs: positiveInteger(health.firstTokenTimeoutMs),
			stallTimeoutMs: positiveInteger(health.stallTimeoutMs),
		}),
		escalation: compact({
			afterStalls: positiveInteger(escalation.afterStalls),
			afterFailedCommands: positiveInteger(escalation.afterFailedCommands),
			maxNudgesPerRun: nonNegativeInteger(escalation.maxNudgesPerRun),
		}),
		utility: compact({
			classifier: modelId(utility.classifier),
			judge: modelId(utility.judge),
			summarizer: modelId(utility.summarizer),
			commit: modelId(utility.commit),
		}),
		sticky: typeof raw.sticky === "boolean" ? raw.sticky : undefined,
		contextMarginRatio: margin !== undefined && margin >= 1 ? margin : undefined,
		compaction: normalizeCompaction(raw.compaction),
	})
}

/** The stored map with unknown profiles and invalid fields dropped. */
export function normalizeRouterTuning(value: unknown): RouterTuningMap {
	const raw = record(value)
	const map: RouterTuningMap = {}
	if (!raw) {
		return map
	}
	for (const [profile, entry] of Object.entries(raw)) {
		if (!isRouterTuningProfile(profile)) {
			continue
		}
		const tuning = normalizeRouterProfileTuning(entry)
		if (tuning) {
			map[profile] = tuning
		}
	}
	return map
}
