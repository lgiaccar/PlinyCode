/**
 * Router tuning the user sets in Settings → Router: per router profile, a
 * priority-ordered model list and overrides for every knob of the routing
 * rules. Stored as one map (`routerTuning` in global state) and laid over the
 * rules files by the router (`src/sdk/router/router-tuning.ts`), so only the
 * fields set here change anything. Model ids are checked there too: a FreeAuto
 * profile drops paid ids however they got in.
 */

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
}

export type RouterTuningMap = Partial<Record<RouterTuningProfile, RouterProfileTuning>>

/** One model the Router settings may offer for a profile. */
export interface RouterModelOption {
	id: string
	name: string
	free: boolean
	contextWindow?: number
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
