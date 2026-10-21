/**
 * Settings → Router's compaction sizes handed to the engine. A router compacts
 * against its compiled budget (`plinyRouterBudget`) unless its tuning sets a
 * budget or a target; both are resolved to tokens here, so the engine never
 * sees a unit, and re-read before every model call, so a change applies to a
 * running conversation.
 */

import type { CoreCompactionConfig } from "@plinycode/core"
import { isPlinyRouterModelId, plinyRouterBudget, plinyRouterProfile } from "@plinycode/llms"
import { type ModelTuning, tunedInputTokens } from "@/shared/model-tuning"
import { isRouterTuningProfile, normalizeRouterTuning, resolveRouterCompaction } from "@/shared/router-tuning"

type RouterCompactionOverrides = Pick<CoreCompactionConfig, "maxInputTokensOverride" | "targetTokensOverride">

/**
 * The compaction overrides of a router session, or none for a concrete model.
 * A model tuning's smaller context still wins over a raised router budget, as
 * it does over the compiled one.
 */
export function routerCompactionOverrides(
	modelId: string,
	readTuning: () => unknown,
	modelTuning?: ModelTuning,
): RouterCompactionOverrides {
	if (!isPlinyRouterModelId(modelId)) {
		return {}
	}
	const profile = plinyRouterProfile(modelId)
	const defaultBudget = plinyRouterBudget(profile)?.maxInputTokens
	if (!isRouterTuningProfile(profile) || defaultBudget === undefined) {
		return {}
	}
	const resolve = () => resolveRouterCompaction(normalizeRouterTuning(readTuning())[profile]?.compaction, defaultBudget)
	return {
		maxInputTokensOverride: () => {
			const budget = resolve().budgetTokens
			return budget === undefined ? undefined : tunedInputTokens(budget, modelTuning)
		},
		targetTokensOverride: () => resolve().targetTokens,
	}
}
