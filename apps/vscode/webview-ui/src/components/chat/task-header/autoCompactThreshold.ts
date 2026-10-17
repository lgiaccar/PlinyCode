/** `plinycode.compaction.threshold`'s default and range: a share of the model's input limit. */
export const DEFAULT_COMPACTION_THRESHOLD = 0.9
const MIN_COMPACTION_THRESHOLD = 0.1
const MAX_COMPACTION_THRESHOLD = 0.95

type ModelLimits = { contextWindow?: number; maxInputTokens?: number }

/**
 * The model's input limit: its maxInputTokens, or 90% of its context window
 * when only that is known (the engine's CONTEXT_WINDOW_INPUT_RATIO).
 * Undefined without a window.
 */
function inputLimitFor(info?: ModelLimits): number | undefined {
	if (!info?.contextWindow || info.contextWindow <= 0) {
		return undefined
	}
	return info.maxInputTokens && info.maxInputTokens > 0 ? info.maxInputTokens : info.contextWindow * 0.9
}

export function clampCompactionThreshold(threshold: number): number {
	return Math.min(MAX_COMPACTION_THRESHOLD, Math.max(MIN_COMPACTION_THRESHOLD, threshold))
}

/**
 * Where auto-condense runs, as a share of the context window:
 * `compactionThreshold` (90% by default) of the model's input limit
 * (docs/context-compaction.md). The routers advertise a window far above
 * their input budget, so the marker sits well left of the bar's end there.
 * Undefined without a window.
 */
export function autoCompactThresholdFor(
	info?: ModelLimits,
	compactionThreshold: number = DEFAULT_COMPACTION_THRESHOLD,
): number | undefined {
	const inputLimit = inputLimitFor(info)
	if (inputLimit === undefined || !info?.contextWindow) {
		return undefined
	}
	return Math.min(1, (inputLimit * clampCompactionThreshold(compactionThreshold)) / info.contextWindow)
}

/**
 * The inverse: the compaction threshold (a share of the input limit) that
 * puts the marker at `position`, a share of the context window — where the
 * bar was clicked. Rounded to whole percent and clamped to the setting's
 * range; undefined without a window.
 */
export function compactionThresholdAt(position: number, info?: ModelLimits): number | undefined {
	const inputLimit = inputLimitFor(info)
	if (inputLimit === undefined || !info?.contextWindow || !Number.isFinite(position)) {
		return undefined
	}
	const threshold = (position * info.contextWindow) / inputLimit
	return clampCompactionThreshold(Math.round(threshold * 100) / 100)
}
