/**
 * Per-conversation budget.
 *
 * Every conversation has its own budget in USD, shown next to its cost in the
 * task header (`$cost / $budget`) and editable there. It is stored on the
 * conversation's history record; a conversation without one uses the default,
 * `plinycode.spending.conversationLimit`.
 *
 * Checked before every paid model call. When the conversation's spend reaches
 * its budget the run stops, like the mistake limit: the session stays
 * resumable and the user continues by sending a message. The stop also raises
 * the budget by one step (the default budget), so continuing allows one more
 * round and the header shows the new budget. Free models are never checked.
 */

export interface SpendingLimitHit {
	/** What the conversation has spent, in USD. */
	spent: number
	/** The budget that was reached, in USD. */
	budget: number
	/** The raised budget: where the next pause happens if the user continues. */
	nextBudget: number
}

/** Rounds up to whole cents, so a raised budget reads like one the user typed. */
const ceilCents = (value: number) => Math.ceil(value * 100 - 1e-9) / 100

/**
 * Returns a hit when `spent` has reached `budget`. A `budget` of 0 (or less)
 * means no limit. `step` is how much a stop raises the budget beyond what has
 * been spent; when it is not positive (the default budget is off) the
 * conversation's own budget is used as the step.
 */
export function checkConversationBudget(spent: number, budget: number, step: number): SpendingLimitHit | undefined {
	if (!(budget > 0) || !Number.isFinite(spent) || spent < budget) {
		return undefined
	}
	const increment = step > 0 ? step : budget
	return { spent, budget, nextBudget: ceilCents(spent + increment) }
}

const usd = (value: number) => `$${value.toFixed(2)}`

export function formatSpendingLimitMessage(hit: SpendingLimitHit): string {
	return (
		`This conversation has spent ${usd(hit.spent)}, reaching its ${usd(hit.budget)} budget, so PlinyCode paused it.\n\n` +
		`Send a message to continue: its budget is now ${usd(hit.nextBudget)}. ` +
		"To set a different budget, click it next to the conversation's cost in the task header (0 = no limit). " +
		"Free models are never limited."
	)
}
