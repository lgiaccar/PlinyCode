import type { ClineMessage, ClineSubagentUsageInfo } from "@shared/ExtensionMessage"

/**
 * How a conversation's usage is kept in its session metadata, and read back
 * as the totals the history list shows.
 *
 * Two writers share the metadata:
 *
 * - **The engine** writes what its agents used at the end of every turn:
 *   `usage` and `totalCost` for the root agent, `aggregateUsage` and
 *   `aggregatedAgentsCost` for the root agent plus its sub-agents.
 * - **The extension** writes the totals the task header shows
 *   (`tokensIn`, `tokensOut`, `cacheReads`, `cacheWrites`, `totalCost`) on
 *   every usage event, and, under `extraUsage`, the calls the engine never
 *   sees: the advisor's (`ask_advisor`), the compaction summarizer's and the
 *   router's image descriptions (`vision`).
 *
 * Both write `totalCost`, and the engine's end-of-turn write could land last
 * with the root agent's cost alone, so the history list dropped advisor,
 * compaction and sub-agent cost. The engine never writes `extraUsage`, so
 * the engine's aggregate plus `extraUsage` is a total no late write can
 * shrink. The extension's own totals still count, since they run ahead of
 * the engine's between turn ends (a background task's budget check reads
 * them): each field is the larger of the two. A session written before
 * `extraUsage` existed reads its own totals exactly as before.
 */

/** History metadata fields that hold the task header's usage totals. */
export const USAGE_METADATA_KEYS = ["totalCost", "tokensIn", "tokensOut", "cacheWrites", "cacheReads"] as const

/** Usage totals in the task header's buckets: `tokensIn` leaves out the cached input. */
export type TaskUsageTotals = Record<(typeof USAGE_METADATA_KEYS)[number], number>

/** The metadata key the extension keeps the engine-invisible usage under. */
export const EXTRA_USAGE_METADATA_KEY = "extraUsage"

/**
 * Calls made outside the engine's agents. The review pass and the routers'
 * classifier and completion judge run on free models and record no usage.
 */
export type ExtraUsageSource = "advisor" | "compaction" | "vision"

/** `extraUsage`: totals per source. Unknown sources (from a newer build) are kept and counted. */
export type ExtraUsage = Partial<Record<string, TaskUsageTotals>>

const EXTRA_USAGE_SOURCES: readonly string[] = ["advisor", "compaction", "vision"] satisfies ExtraUsageSource[]

type Metadata = Record<string, unknown> | null | undefined

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function emptyTotals(): TaskUsageTotals {
	return { totalCost: 0, tokensIn: 0, tokensOut: 0, cacheWrites: 0, cacheReads: 0 }
}

function addTotals(left: TaskUsageTotals, right: Partial<TaskUsageTotals>): TaskUsageTotals {
	return {
		totalCost: left.totalCost + Math.max(0, right.totalCost ?? 0),
		tokensIn: left.tokensIn + Math.max(0, right.tokensIn ?? 0),
		tokensOut: left.tokensOut + Math.max(0, right.tokensOut ?? 0),
		cacheWrites: left.cacheWrites + Math.max(0, right.cacheWrites ?? 0),
		cacheReads: left.cacheReads + Math.max(0, right.cacheReads ?? 0),
	}
}

function parseTotals(value: unknown): TaskUsageTotals | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined
	}
	const record = value as Record<string, unknown>
	return {
		totalCost: finite(record.totalCost) ?? 0,
		tokensIn: finite(record.tokensIn) ?? 0,
		tokensOut: finite(record.tokensOut) ?? 0,
		cacheWrites: finite(record.cacheWrites) ?? 0,
		cacheReads: finite(record.cacheReads) ?? 0,
	}
}

/** The extension's own totals: what the task header showed at its last write. */
function readStoredUsageTotals(metadata: Metadata): TaskUsageTotals {
	return Object.fromEntries(USAGE_METADATA_KEYS.map((key) => [key, finite(metadata?.[key]) ?? 0])) as TaskUsageTotals
}

/** `extraUsage`, or undefined for a session written before it existed. */
export function readExtraUsage(metadata: Metadata): ExtraUsage | undefined {
	const value = metadata?.[EXTRA_USAGE_METADATA_KEY]
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined
	}
	const extra: ExtraUsage = {}
	for (const [source, totals] of Object.entries(value as Record<string, unknown>)) {
		const parsed = parseTotals(totals)
		if (parsed) {
			extra[source] = parsed
		}
	}
	return extra
}

/** `extra` with `usage` added to one source's totals. */
export function addExtraUsage(
	extra: ExtraUsage | undefined,
	source: ExtraUsageSource,
	usage: Partial<TaskUsageTotals>,
): ExtraUsage {
	return { ...(extra ?? {}), [source]: addTotals(extra?.[source] ?? emptyTotals(), usage) }
}

/**
 * The advisor's, the summarizer's and the image describer's calls, from the
 * transcript's usage rows (`subagent_usage` with that source). Every source is
 * always present, so writing the result marks the session as keeping `extraUsage`.
 */
export function extraUsageFromMessages(messages: ClineMessage[]): ExtraUsage {
	const extra: ExtraUsage = Object.fromEntries(EXTRA_USAGE_SOURCES.map((source) => [source, emptyTotals()]))
	for (const message of messages) {
		if (message.type !== "say" || message.say !== "subagent_usage" || !message.text) {
			continue
		}
		let info: Partial<ClineSubagentUsageInfo>
		try {
			info = JSON.parse(message.text)
		} catch {
			continue
		}
		const source = info.source
		if (!source || !EXTRA_USAGE_SOURCES.includes(source)) {
			continue
		}
		extra[source] = addTotals(extra[source] ?? emptyTotals(), {
			totalCost: finite(info.cost),
			tokensIn: finite(info.tokensIn),
			tokensOut: finite(info.tokensOut),
			cacheWrites: finite(info.cacheWrites),
			cacheReads: finite(info.cacheReads),
		})
	}
	return extra
}

/**
 * The engine's aggregate (root agent plus sub-agents) in the header's
 * buckets. The engine counts cached input inside `inputTokens`, as the
 * message translator's usage rows assume.
 */
function readEngineUsage(metadata: Metadata): TaskUsageTotals | undefined {
	const aggregate = metadata?.aggregateUsage
	if (aggregate && typeof aggregate === "object" && !Array.isArray(aggregate)) {
		const record = aggregate as Record<string, unknown>
		const cacheReads = finite(record.cacheReadTokens) ?? 0
		const cacheWrites = finite(record.cacheWriteTokens) ?? 0
		return {
			totalCost: finite(record.totalCost) ?? 0,
			tokensIn: Math.max(0, (finite(record.inputTokens) ?? 0) - cacheReads - cacheWrites),
			tokensOut: finite(record.outputTokens) ?? 0,
			cacheWrites,
			cacheReads,
		}
	}
	const cost = finite(metadata?.aggregatedAgentsCost)
	return cost === undefined ? undefined : { ...emptyTotals(), totalCost: cost }
}

/**
 * The conversation's usage totals as the history list shows them; see the
 * comment at the top of this file.
 */
export function readTaskUsageTotals(metadata: Metadata): TaskUsageTotals {
	const stored = readStoredUsageTotals(metadata)
	const extra = readExtraUsage(metadata)
	if (!extra) {
		return stored
	}
	let settled = readEngineUsage(metadata) ?? emptyTotals()
	for (const totals of Object.values(extra)) {
		if (totals) {
			settled = addTotals(settled, totals)
		}
	}
	return Object.fromEntries(USAGE_METADATA_KEYS.map((key) => [key, Math.max(stored[key], settled[key])])) as TaskUsageTotals
}
