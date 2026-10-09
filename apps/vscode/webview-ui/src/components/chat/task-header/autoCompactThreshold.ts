/**
 * Where auto-condense runs, as a share of the context window: 90% of the
 * model's input limit (docs/context-compaction.md). The routers advertise a
 * window far above their input budget, so the marker sits well left of the
 * bar's end there. Undefined without a window.
 */
export function autoCompactThresholdFor(info?: { contextWindow?: number; maxInputTokens?: number }): number | undefined {
	if (!info?.contextWindow || info.contextWindow <= 0) {
		return undefined
	}
	const inputLimit = info.maxInputTokens && info.maxInputTokens > 0 ? info.maxInputTokens : info.contextWindow * 0.9
	return Math.min(1, (inputLimit * 0.9) / info.contextWindow)
}
