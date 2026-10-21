import { combineApiRequests } from "./combineApiRequests"
import { ClineContextBreakdown, ClineMessage } from "./ExtensionMessage"

interface ApiMetrics {
	totalTokensIn: number
	totalTokensOut: number
	totalCacheWrites?: number
	totalCacheReads?: number
	totalCost: number
	/** True when any summed request's tokens are a char-based estimate rather than provider-reported. */
	hasEstimatedUsage?: boolean
}

/**
 * Calculates API metrics from an array of ClineMessages.
 *
 * This function processes usage-carrying say messages.
 * It includes:
 * - 'api_req_started' messages that have been combined with their corresponding 'api_req_finished' messages
 * - 'deleted_api_reqs' messages, which are aggregated from deleted messages
 * - 'subagent_usage' messages, which are aggregated usage snapshots emitted by subagent batches
 * It extracts and sums up the tokensIn, tokensOut, cacheWrites, cacheReads, and cost from these messages.
 *
 * @param messages - An array of ClineMessage objects to process.
 * @returns An ApiMetrics object containing totalTokensIn, totalTokensOut, totalCacheWrites, totalCacheReads, and totalCost.
 *
 * @example
 * const messages = [
 *   { type: "say", say: "api_req_started", text: '{"request":"GET /api/data","tokensIn":10,"tokensOut":20,"cost":0.005}', ts: 1000 }
 * ];
 * const { totalTokensIn, totalTokensOut, totalCost } = getApiMetrics(messages);
 * // Result: { totalTokensIn: 10, totalTokensOut: 20, totalCost: 0.005 }
 */
export function getApiMetrics(messages: ClineMessage[]): ApiMetrics {
	const result: ApiMetrics = {
		totalTokensIn: 0,
		totalTokensOut: 0,
		totalCacheWrites: undefined,
		totalCacheReads: undefined,
		totalCost: 0,
	}

	messages.forEach((message) => {
		if (
			message.type === "say" &&
			(message.say === "api_req_started" || message.say === "deleted_api_reqs" || message.say === "subagent_usage") &&
			message.text
		) {
			try {
				const parsedData = JSON.parse(message.text)
				const { tokensIn, tokensOut, cacheWrites, cacheReads, cost, estimated } = parsedData

				if (typeof tokensIn === "number") {
					result.totalTokensIn += tokensIn
				}
				if (typeof tokensOut === "number") {
					result.totalTokensOut += tokensOut
				}
				if (typeof cacheWrites === "number") {
					result.totalCacheWrites = (result.totalCacheWrites ?? 0) + cacheWrites
				}
				if (typeof cacheReads === "number") {
					result.totalCacheReads = (result.totalCacheReads ?? 0) + cacheReads
				}
				if (typeof cost === "number") {
					result.totalCost += cost
				}
				if (estimated === true) {
					result.hasEstimatedUsage = true
				}
			} catch {
				// Ignore JSON parse errors
			}
		}
	})

	return result
}

/**
 * Usage totals for a whole conversation, computed the way the chat's task
 * header computes them: every row after the task message, with each
 * api_req_started merged with its api_req_finished. The spending limit and
 * the history list use this so they agree with what the header shows.
 */
export function getConversationApiMetrics(messages: ClineMessage[]): ApiMetrics {
	return getApiMetrics(combineApiRequests(messages.slice(1)))
}

/**
 * Gets the total token count from the last API request.
 *
 * This is used for context window progress display - it shows how much of the
 * context window is used in the current/most recent request, not cumulative totals.
 *
 * A completed compaction divider that postdates the last request rescales that
 * request's total by the compaction's tokensAfter/tokensBefore ratio, so the
 * context-window bar updates immediately instead of waiting for the next
 * request to run. The ratio is used rather than tokensAfter itself because the
 * compaction counters are the SDK's estimate (chars/4-class), a different
 * scale from the provider-reported usage that normally drives this value —
 * substituting the estimate would make the bar visibly re-snap when the next
 * request's real usage lands. Both counters come from the same estimator, so
 * their ratio is scale-free. Multiple compactions since the last request
 * compound. The ratio is deliberately not clamped to 1: compacting a small
 * conversation can grow the context (the summary outweighs the original
 * messages), and the header must move in the same direction as the divider row
 * (e.g. "1k → 1.3k tokens") rather than silently show the stale value.
 *
 * The count is the request's input only: `contextTokens`, or tokensIn +
 * cacheWrites + cacheReads on rows written before it existed. The reply's
 * output used to be added too, which made the bar drop on the next call
 * whenever that output (reasoning above all) was not sent back.
 *
 * @param messages - An array of ClineMessage objects to process.
 * @returns The last api_req_started message's input tokens, rescaled by any completed compactions that happened after it, or 0 if none found.
 */
export function getLastApiReqTotalTokens(messages: ClineMessage[]): number {
	let shrinkFraction: number | undefined
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.type !== "say" || !msg.text) {
			continue
		}
		if (msg.say === "compaction") {
			try {
				const { status, tokensBefore, tokensAfter } = JSON.parse(msg.text)
				if (
					status === "completed" &&
					typeof tokensBefore === "number" &&
					typeof tokensAfter === "number" &&
					tokensBefore > 0 &&
					tokensAfter > 0
				) {
					shrinkFraction = (shrinkFraction ?? 1) * (tokensAfter / tokensBefore)
				}
			} catch {
				// Ignore JSON parse errors, continue searching
			}
		}
		if (msg.say === "api_req_started") {
			try {
				const { tokensIn, cacheWrites, cacheReads, contextTokens } = JSON.parse(msg.text)
				const total =
					typeof contextTokens === "number" && contextTokens > 0
						? contextTokens
						: (tokensIn || 0) + (cacheWrites || 0) + (cacheReads || 0)
				if (total > 0) {
					return shrinkFraction === undefined ? total : Math.ceil(total * shrinkFraction)
				}
			} catch {
				// Ignore JSON parse errors, continue searching
			}
		}
	}
	return 0
}

/**
 * The context source breakdown attached to the most recent api_req_started
 * message that carries one. Mirrors getLastApiReqTotalTokens's "most recent
 * request wins" semantics, but is not rescaled by compaction: the breakdown
 * is replaced wholesale by the next request rather than shrunk in place.
 *
 * @param messages - An array of ClineMessage objects to process.
 * @returns The last reported contextBreakdown, or undefined if none found.
 */
export function getLastContextBreakdown(messages: ClineMessage[]): ClineContextBreakdown | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.type !== "say" || msg.say !== "api_req_started" || !msg.text) {
			continue
		}
		try {
			const { contextBreakdown } = JSON.parse(msg.text)
			if (contextBreakdown && typeof contextBreakdown === "object") {
				return contextBreakdown as ClineContextBreakdown
			}
		} catch {
			// Ignore JSON parse errors, continue searching
		}
	}
	return undefined
}

/**
 * Tokens the engine left out of the most recent request before sending it
 * (old tool output, earlier reasoning, superseded reads): what the context
 * bar's breakdown names when the size dropped without a compaction. 0 when
 * the last request trimmed nothing or predates the field.
 */
export function getLastPrunedTokens(messages: ClineMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.type !== "say" || msg.say !== "api_req_started" || !msg.text) {
			continue
		}
		try {
			const { prunedTokens, tokensIn, cacheReads, contextTokens } = JSON.parse(msg.text)
			if (!(tokensIn || cacheReads || contextTokens)) {
				// The row written when the request started carries no usage yet.
				continue
			}
			return typeof prunedTokens === "number" && prunedTokens > 0 ? prunedTokens : 0
		} catch {
			// Ignore JSON parse errors, continue searching
		}
	}
	return 0
}
