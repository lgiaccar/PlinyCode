/**
 * Model selection for FreeAuto. Pure: given the request's features, the rules,
 * which models are currently healthy, and optionally the classifier's verdict,
 * produce an ordered candidate list and the reasoning effort to ask for.
 *
 * Kept free of I/O and SDK objects so the routing decision can be unit-tested
 * exhaustively.
 */

import type { ModelInfo, PlinyThinkingControls } from "@plinycode/llms"
import type {
	RouterClassification,
	RouterDecision,
	RouterEffort,
	RouterReasoningEffort,
	RouterRequestFeatures,
	RouterRoute,
	RouterRules,
} from "./router-types"

/** A route matches when every condition it declares holds. */
export function routeMatches(route: RouterRoute, features: RouterRequestFeatures): boolean {
	const when = route.when
	if (!when) {
		return true
	}
	if (when.mode && when.mode !== features.mode) {
		return false
	}
	if (when.minEstimatedTokens !== undefined && features.estimatedTokens < when.minEstimatedTokens) {
		return false
	}
	if (when.maxEstimatedTokens !== undefined && features.estimatedTokens > when.maxEstimatedTokens) {
		return false
	}
	if (when.maxPromptChars !== undefined && features.prompt.length > when.maxPromptChars) {
		return false
	}
	if (when.subAgent !== undefined && when.subAgent !== features.isSubAgent) {
		return false
	}
	if (when.promptRegex) {
		try {
			if (!new RegExp(when.promptRegex, "i").test(features.prompt)) {
				return false
			}
		} catch {
			// A pattern that survived parsing but fails here cannot match.
			return false
		}
	}
	return true
}

/**
 * The hard part of a route's conditions: size and sub-agent. A classifier pick
 * must still satisfy these, because a request that is too large for the route's
 * models, or a main-agent call on a sub-agent route, would be a wrong route no
 * matter what the classifier thought.
 */
function routeAdmits(route: RouterRoute, features: RouterRequestFeatures): boolean {
	const when = route.when
	if (!when) {
		return true
	}
	if (when.minEstimatedTokens !== undefined && features.estimatedTokens < when.minEstimatedTokens) {
		return false
	}
	if (when.maxEstimatedTokens !== undefined && features.estimatedTokens > when.maxEstimatedTokens) {
		return false
	}
	return when.subAgent === undefined || when.subAgent === features.isSubAgent
}

/**
 * The route for a call: the first route tagged with the classifier's tier when
 * there is a verdict and that route admits the request, otherwise the first
 * route whose conditions all match.
 */
export function selectRoute(
	rules: RouterRules,
	features: RouterRequestFeatures,
	classification?: RouterClassification,
): RouterRoute | undefined {
	if (classification) {
		const tiered = rules.routes.find((route) => route.tier === classification.tier && routeAdmits(route, features))
		if (tiered) {
			return tiered
		}
	}
	return rules.routes.find((route) => routeMatches(route, features))
}

/**
 * The request options that give one model the requested effort, or undefined
 * when it cannot be given. Only models with measured thinking controls are
 * touched: a switch a backend does not know fails the whole call (several
 * self-hosted models answer `reasoning_effort` with a 400).
 *
 * - think on a model that reasons by default clears any setting, so its
 *   default applies; asking again via `reasoning_effort` could be rejected.
 * - think on a model whose on-switch is `reasoning_effort` turns it on at the
 *   route's level. A chat-template-only on-switch cannot be reached (the
 *   gateway expresses "on" only as `reasoning_effort`), so such a model is left alone.
 * - quick turns reasoning off and clears any effort level, so a global
 *   "thinking on" setting does not leak into a call meant to be fast.
 */
export function effortOptions(
	effort: RouterEffort | undefined,
	reasoningEffort: RouterReasoningEffort | undefined,
	controls: PlinyThinkingControls | undefined,
): { thinking: boolean | undefined; reasoningEffort: RouterReasoningEffort | undefined } | undefined {
	if (!effort || !controls) {
		return undefined
	}
	if (effort === "think") {
		if (controls.defaultOn) {
			return { thinking: undefined, reasoningEffort: undefined }
		}
		return controls.on === "reasoning-effort" ? { thinking: true, reasoningEffort: reasoningEffort ?? "medium" } : undefined
	}
	return !controls.defaultOn || controls.off ? { thinking: false, reasoningEffort: undefined } : undefined
}

/**
 * Whether a model's context window can hold the request, with the configured
 * safety margin. Models whose window we do not know are allowed through: the
 * gateway is the authority, and excluding them would shrink the pool on
 * metadata gaps alone.
 */
export function fitsContext(
	modelId: string,
	features: RouterRequestFeatures,
	rules: RouterRules,
	knownModels: Record<string, ModelInfo> | undefined,
): boolean {
	const contextWindow = knownModels?.[modelId]?.contextWindow
	if (!contextWindow || contextWindow <= 0) {
		return true
	}
	return contextWindow >= features.estimatedTokens * rules.contextMarginRatio
}

/**
 * Whether a model declares image input. Unlike `fitsContext`, unknown metadata
 * means "no": sending an image to a text-only model is a hard failure, not a
 * maybe.
 */
export function supportsImages(modelId: string, knownModels: Record<string, ModelInfo> | undefined): boolean {
	return knownModels?.[modelId]?.capabilities?.includes("images") ?? false
}

/**
 * Build the ordered candidate list for a call.
 *
 * Order: the matching route's models, then the rest of the pool as backups.
 * A sticky choice from earlier in the turn is promoted to the front when it is
 * still healthy and still large enough, so a turn does not hop between models
 * for no reason.
 *
 * Unhealthy and too-small models are filtered out, but never all of them: if
 * filtering would leave nothing, the size filter is relaxed first (a too-small
 * window is a maybe, an unhealthy model is a known problem) and finally the
 * health filter, because refusing to make the call at all is worse than trying
 * a model that failed earlier.
 *
 * The image filter is never relaxed: a request with images can only go to a
 * model that accepts them, and an empty result is the caller's cue to refuse.
 */
export function selectCandidates(context: {
	rules: RouterRules
	features: RouterRequestFeatures
	knownModels?: Record<string, ModelInfo>
	isHealthy: (modelId: string) => boolean
	classification?: RouterClassification
}): RouterDecision {
	const { rules, features, knownModels, isHealthy, classification } = context
	const route = selectRoute(rules, features, classification)
	const routeName = route?.name ?? "default"
	// The classifier's think/quick verdict is more specific than a route default.
	const effort: RouterEffort | undefined = classification ? (classification.think ? "think" : "quick") : route?.effort

	const poolSet = new Set(rules.pool)
	const ordered: string[] = []
	const push = (id: string) => {
		if (poolSet.has(id) && !ordered.includes(id)) {
			ordered.push(id)
		}
	}

	if (rules.sticky && features.stickyModelId) {
		push(features.stickyModelId)
	}
	for (const id of route?.use ?? []) {
		push(id)
	}
	for (const id of rules.pool) {
		push(id)
	}

	const excludedNoImages: string[] = []
	if (features.hasImages) {
		const eligible = ordered.filter((id) => {
			const ok = supportsImages(id, knownModels)
			if (!ok) {
				excludedNoImages.push(id)
			}
			return ok
		})
		ordered.splice(0, ordered.length, ...eligible)
	}

	const excludedUnhealthy: string[] = []
	const excludedTooSmall: string[] = []
	const healthy: string[] = []
	for (const id of ordered) {
		if (!isHealthy(id)) {
			excludedUnhealthy.push(id)
			continue
		}
		if (!fitsContext(id, features, rules, knownModels)) {
			excludedTooSmall.push(id)
			continue
		}
		healthy.push(id)
	}

	let candidates = healthy
	if (candidates.length === 0) {
		// Relax the size filter first: it is an estimate, not a verdict.
		candidates = ordered.filter((id) => isHealthy(id))
	}
	if (candidates.length === 0) {
		// Everything is benched. Try anyway, best-first, rather than refusing.
		candidates = ordered
	}

	return {
		candidates,
		routeName,
		...(effort ? { effort } : {}),
		...(route?.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
		...(classification ? { classification } : {}),
		excludedUnhealthy,
		excludedTooSmall,
		excludedNoImages,
	}
}
