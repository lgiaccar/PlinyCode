/**
 * Pliny gateway budget: `GET <gateway>/api/svc/v1/llm-gateway/budgets/my-usage`.
 *
 * The gateway answers with every budget rule that matched the caller:
 *
 * ```json
 * {"matched":[{"name":"default-budget-rule","applies_to":"per-user","mode":"enforce",
 *   "entities":[{"entity":"{user:me@synopsys.com}","periods":{"cost_per_month":
 *     {"limit":200,"used":111.92,"percentage":55.96,"start":1788220800,"end":1790812799,"is_blocked":false}}}]}]}
 * ```
 *
 * The one that binds is the period with the least money left, so that is
 * the one PlinyCode shows.
 */

export const PLINY_BUDGET_PATH = "/api/svc/v1/llm-gateway/budgets/my-usage"

export interface PlinyBudget {
	/** Spending cap for the period, in USD. */
	limit: number
	/** Spent so far in the period, in USD. */
	used: number
	/** limit - used, never below 0. */
	remaining: number
	/** Share of the limit used, 0–100. */
	percentage: number
	/** Period key from the gateway, e.g. "cost_per_month". */
	period: string
	/** Period end, epoch milliseconds (0 when unknown). */
	periodEndMs: number
	/** True when the gateway is refusing requests for this budget. */
	isBlocked: boolean
	/** Whether the rule is enforced ("enforce") or only tracked. */
	mode?: string
}

const toNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

/** Picks the binding budget out of a my-usage response; undefined when there is none. */
export function parsePlinyBudget(payload: unknown): PlinyBudget | undefined {
	const matched = (payload as { matched?: unknown })?.matched
	if (!Array.isArray(matched)) {
		return undefined
	}
	let best: PlinyBudget | undefined
	for (const rule of matched) {
		const entities = (rule as { entities?: unknown })?.entities
		if (!Array.isArray(entities)) {
			continue
		}
		const mode = typeof rule.mode === "string" ? rule.mode : undefined
		for (const entity of entities) {
			const periods = (entity as { periods?: unknown })?.periods
			if (!periods || typeof periods !== "object") {
				continue
			}
			for (const [period, raw] of Object.entries(periods as Record<string, unknown>)) {
				const data = raw as Record<string, unknown> | undefined
				const limit = toNumber(data?.limit)
				const used = toNumber(data?.used)
				if (limit === undefined || used === undefined) {
					continue
				}
				const budget: PlinyBudget = {
					limit,
					used,
					remaining: Math.max(0, limit - used),
					percentage: toNumber(data?.percentage) ?? (limit > 0 ? (used / limit) * 100 : 100),
					period,
					periodEndMs: (toNumber(data?.end) ?? 0) * 1000,
					isBlocked: data?.is_blocked === true,
					mode,
				}
				if (!best || budget.isBlocked || (!best.isBlocked && budget.remaining < best.remaining)) {
					best = budget
				}
			}
		}
	}
	return best
}

/** "month" for "cost_per_month", "day" for "cost_per_day", else the raw key. */
export function plinyBudgetPeriodLabel(period: string): string {
	const match = /_per_(\w+)$/.exec(period)
	return match ? match[1] : period
}
