/**
 * Shared contracts for the Pliny FreeAuto router.
 *
 * The router picks a concrete free Pliny model for every LLM call and fails
 * over to a backup when one misbehaves. Types live here so the pure policy,
 * the health registry, and the `AgentModel` wrapper can all refer to them
 * without importing each other.
 */

/** A route's matching conditions. All present conditions must hold. */
export interface RouterRouteCondition {
	/** Restrict the route to plan or act mode. */
	mode?: "plan" | "act"
	/** Lower bound on the estimated request size, in tokens. */
	minEstimatedTokens?: number
	/** Upper bound on the estimated request size, in tokens. */
	maxEstimatedTokens?: number
	/** Upper bound on the length of the latest user prompt, in characters. */
	maxPromptChars?: number
	/** Case-insensitive regular expression matched against the latest user prompt. */
	promptRegex?: string
}

export interface RouterRoute {
	/** Shown in the routing row so the user can tell which rule fired. */
	name: string
	when?: RouterRouteCondition
	/** Candidate models, best first. Ids outside the free pool are dropped. */
	use: string[]
}

export interface RouterHealthSettings {
	/** How long a model stays benched after it trips the failure threshold. */
	cooldownMs: number
	/** Consecutive failures before a model is benched. */
	failuresBeforeCooldown: number
	/** Upper bound on failovers within a single user turn. */
	maxFailoversPerTurn: number
	/** No output at all for this long aborts the call. */
	firstTokenTimeoutMs: number
	/** A stream that stops producing for this long aborts the call. */
	stallTimeoutMs: number
}

export interface RouterClassifierSettings {
	/** Off by default: heuristics decide unless the user opts in. */
	enabled: boolean
	timeoutMs: number
	maxPromptChars: number
}

export interface RouterUtilityModels {
	/** Model asked to classify the prompt when the classifier is enabled. */
	classifier: string
	/** Model used for conversation compaction summaries. */
	summarizer: string
	/** Model used for commit message generation. */
	commit: string
}

export interface RouterRules {
	version: number
	/** Ordered fallback pool; every candidate list is filtered against it. */
	pool: string[]
	utility: RouterUtilityModels
	classifier: RouterClassifierSettings
	health: RouterHealthSettings
	/** Multiplier applied to the estimate when checking a context window. */
	contextMarginRatio: number
	/** Keep a turn's first choice for later iterations when still viable. */
	sticky: boolean
	routes: RouterRoute[]
	/** Prose outside the YAML block, handed to the classifier as guidance. */
	guidance?: string
}

/** Everything the policy knows about the call it is routing. */
export interface RouterRequestFeatures {
	/** Estimated size of the whole request, in tokens. */
	estimatedTokens: number
	mode: "plan" | "act"
	/** Latest user prompt, used for keyword matching. */
	prompt: string
	/** True when the request carries image parts (no free model accepts them). */
	hasImages: boolean
	/** 1-based index of this call within the turn. */
	callIndex: number
	/** Model this turn already settled on, when sticky routing applies. */
	stickyModelId?: string
}

export interface RouterDecision {
	/** Candidates in preference order; the first is tried first. */
	candidates: string[]
	/** Name of the route that matched, for the routing row. */
	routeName: string
	/** Models excluded because they are benched, for diagnostics. */
	excludedUnhealthy: string[]
	/** Models excluded because their context window is too small. */
	excludedTooSmall: string[]
}

/** One LLM call, as recorded for the end-of-turn summary. */
export interface RouterCallRecord {
	modelId: string
	startedAt: number
	routeName: string
	/** Set when the call failed and the router moved on. */
	failure?: string
}
