/**
 * The conversation budget (`../spending-limit.ts`) as it applies to an advisor
 * call.
 *
 * The rule is the one a paid model call is checked against: no call once the
 * conversation's spend has reached its budget. Two things differ. It applies
 * on every model, because the advisor is paid even when the conversation runs
 * on a free one, which is never checked. And a spent budget refuses the call
 * rather than pausing the run: a free model can carry on without advice, and
 * on a paid model the next model call pauses the run as usual.
 */

import type { ClineMessage } from "@shared/ExtensionMessage"
import { getConversationApiMetrics } from "@shared/getApiMetrics"
import type { HistoryItem } from "@shared/HistoryItem"
import { checkConversationBudget } from "../spending-limit"

interface AdvisorBudgetSources {
	findHistoryItem: (sessionId: string) => Promise<Pick<HistoryItem, "totalCost" | "spendingLimit" | "spendingStep"> | undefined>
	/**
	 * The chat rows of the conversation when it is the open task; undefined
	 * for a background task, which has none until it is reopened.
	 */
	openTaskMessages: (sessionId: string) => ClineMessage[] | undefined
	/** `plinycode.spending.conversationLimit`. */
	defaultBudget: () => number
}

/**
 * Checks a conversation's budget before an advisor call. The open task's
 * spend is read the way the task header shows it, which includes earlier
 * advisor calls (their usage rows); a background task's comes from its history
 * record. Returns why the call may not be made, or undefined.
 */
export async function checkAdvisorBudget(sessionId: string, sources: AdvisorBudgetSources): Promise<string | undefined> {
	const historyItem = await sources.findHistoryItem(sessionId)
	const messages = sources.openTaskMessages(sessionId)
	const spent = messages ? getConversationApiMetrics(messages).totalCost : historyItem?.totalCost
	const defaultBudget = sources.defaultBudget()
	return advisorBudgetRefusal(spent, historyItem?.spendingLimit ?? defaultBudget, historyItem?.spendingStep ?? defaultBudget)
}

/**
 * Why an advisor call may not be made, or undefined when it may. `spent` is
 * undefined when the conversation's cost could not be read.
 */
function advisorBudgetRefusal(spent: number | undefined, budget: number, step: number): string | undefined {
	if (!(budget > 0)) {
		return undefined
	}
	if (spent === undefined || !Number.isFinite(spent)) {
		// A paid call is not made blind.
		return "What this conversation has spent could not be read, so its budget could not be checked."
	}
	const hit = checkConversationBudget(spent, budget, step)
	return hit
		? `This conversation has spent $${hit.spent.toFixed(2)}, reaching its $${hit.budget.toFixed(2)} budget.`
		: undefined
}
