import type { OpenaiReasoningEffort } from "../storage/types"

/**
 * Map a legacy thinking-budget token count onto the reasoning-effort scale.
 *
 * The extension's reasoning control is effort-based (matching the CLI); the
 * SDK translates effort into provider wire formats, including budget-token
 * mapping where required. Budgets persisted by older versions (state fields
 * or migrated `reasoning.budgetTokens` in providers.json) are honored by
 * bucketing them onto the closest effort so extended thinking stays enabled
 * across the upgrade.
 */
export function reasoningEffortFromThinkingBudget(budgetTokens?: number): Exclude<OpenaiReasoningEffort, "none"> | undefined {
	if (typeof budgetTokens !== "number" || !Number.isFinite(budgetTokens) || budgetTokens <= 0) {
		return undefined
	}
	if (budgetTokens <= 2048) {
		return "low"
	}
	if (budgetTokens <= 8192) {
		return "medium"
	}
	return "high"
}
