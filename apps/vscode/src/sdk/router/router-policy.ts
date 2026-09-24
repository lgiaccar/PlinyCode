/**
 * Model selection for FreeAuto. Pure: given the request's features, the rules,
 * and which models are currently healthy, produce an ordered candidate list.
 *
 * Kept free of I/O and SDK objects so the routing decision can be unit-tested
 * exhaustively, and so the same logic can be reused by the classifier path
 * (which only reorders the candidates the heuristics produced).
 */

import type { ModelInfo } from "@plinycode/llms"
import type { RouterDecision, RouterRequestFeatures, RouterRoute, RouterRules } from "./router-types"

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

/** The first matching route, or undefined when none match. */
export function selectRoute(rules: RouterRules, features: RouterRequestFeatures): RouterRoute | undefined {
	return rules.routes.find((route) => routeMatches(route, features))
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
}): RouterDecision {
	const { rules, features, knownModels, isHealthy } = context
	const route = selectRoute(rules, features)
	const routeName = route?.name ?? "default"

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

	return { candidates, routeName, excludedUnhealthy, excludedTooSmall, excludedNoImages }
}
