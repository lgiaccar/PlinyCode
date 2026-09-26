/**
 * Per-conversation spending limit (`plinycode.spending.conversationLimit`).
 *
 * Checked before every model call. When a conversation's spend reaches its
 * threshold the run stops, like the mistake limit: the session stays
 * resumable and the user continues by sending a message. Each stop grants
 * one more round of the limit, so the next threshold is `spent + limit`.
 */

export interface SpendingLimitHit {
	/** What the conversation has spent, in USD. */
	spent: number
	/** The configured per-round limit, in USD. */
	limit: number
	/** Spend at which the next pause happens if the user continues. */
	nextThreshold: number
}

export class ConversationSpendingGuard {
	private readonly thresholds = new Map<string, number>()

	/**
	 * Returns a hit when `spent` has reached the conversation's threshold, and
	 * raises the threshold by one more `limit`. A `limit` of 0 (or less) turns
	 * the guard off. Raising the limit in settings takes effect immediately;
	 * lowering it never re-pauses a round the user already allowed.
	 */
	check(conversationId: string, spent: number, limit: number): SpendingLimitHit | undefined {
		if (!(limit > 0) || !Number.isFinite(spent)) {
			return undefined
		}
		const threshold = Math.max(this.thresholds.get(conversationId) ?? 0, limit)
		if (spent < threshold) {
			return undefined
		}
		const nextThreshold = spent + limit
		this.thresholds.set(conversationId, nextThreshold)
		return { spent, limit, nextThreshold }
	}

	forget(conversationId: string): void {
		this.thresholds.delete(conversationId)
	}
}

const usd = (value: number) => `$${value.toFixed(2)}`

export function formatSpendingLimitMessage(hit: SpendingLimitHit): string {
	return (
		`This conversation has spent ${usd(hit.spent)}, reaching its ${usd(hit.limit)} spending limit, so PlinyCode paused it.\n\n` +
		`Send a message to continue for up to another ${usd(hit.limit)} (next pause at ${usd(hit.nextThreshold)}). ` +
		"You can change the limit in PlinyCode Settings → General, or with the plinycode.spending.conversationLimit setting (0 = no limit)."
	)
}
