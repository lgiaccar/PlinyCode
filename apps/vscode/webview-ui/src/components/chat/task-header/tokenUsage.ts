import type { ClineApiReqInfo, ClineMessage, ClineSubagentUsageInfo } from "@shared/ExtensionMessage"

/** One LLM call's usage, read from its api_req_started row. Token buckets are disjoint. */
export interface ApiCallUsage {
	ts: number
	/** The model that served the call (the routed one for FreeAuto/BalanceAuto); absent on older rows. */
	modelId?: string
	/** Input tokens neither read from nor written to the prompt cache. */
	tokensIn: number
	tokensOut: number
	cacheReads: number
	cacheWrites: number
	/** Hidden reasoning tokens, already counted in tokensOut. */
	reasoningTokens: number
	cost: number
	estimated: boolean
}

export interface ApiCallSummary {
	calls: number
	tokensIn: number
	tokensOut: number
	cacheReads: number
	cacheWrites: number
	reasoningTokens: number
	cost: number
	estimated: boolean
	/** Share of all prompt tokens that were read from the cache (0..1), or undefined with no prompt tokens. */
	cacheHitRate?: number
	/** Models in order of first use, with how many calls each served. */
	models: { modelId: string; calls: number }[]
}

/**
 * The main agent's LLM calls, in order. A live call leaves an empty api_req_started row (the
 * spinner) and a second one carrying usage; only rows with token counts or a cost are calls.
 * Sub-agent, advisor and compaction usage arrive as subagent_usage rows and are not included
 * (see getSideUsage).
 */
export function getApiCallUsages(messages: ClineMessage[]): ApiCallUsage[] {
	const calls: ApiCallUsage[] = []
	for (const message of messages) {
		if (message.type !== "say" || message.say !== "api_req_started" || !message.text) {
			continue
		}
		let info: ClineApiReqInfo
		try {
			info = JSON.parse(message.text)
		} catch {
			continue
		}
		const tokensIn = info.tokensIn ?? 0
		const tokensOut = info.tokensOut ?? 0
		const cacheReads = info.cacheReads ?? 0
		const cacheWrites = info.cacheWrites ?? 0
		const cost = info.cost ?? 0
		if (tokensIn + tokensOut + cacheReads + cacheWrites === 0 && cost === 0) {
			continue
		}
		calls.push({
			ts: message.ts,
			...(info.modelId ? { modelId: info.modelId } : {}),
			tokensIn,
			tokensOut,
			cacheReads,
			cacheWrites,
			reasoningTokens: info.reasoningTokens ?? 0,
			cost,
			estimated: info.estimated === true,
		})
	}
	return calls
}

export function promptTokens(call: Pick<ApiCallUsage, "tokensIn" | "cacheReads" | "cacheWrites">): number {
	return call.tokensIn + call.cacheReads + call.cacheWrites
}

export function summarizeApiCalls(calls: ApiCallUsage[]): ApiCallSummary {
	const summary: ApiCallSummary = {
		calls: calls.length,
		tokensIn: 0,
		tokensOut: 0,
		cacheReads: 0,
		cacheWrites: 0,
		reasoningTokens: 0,
		cost: 0,
		estimated: false,
		models: [],
	}
	const modelCalls = new Map<string, number>()
	for (const call of calls) {
		summary.tokensIn += call.tokensIn
		summary.tokensOut += call.tokensOut
		summary.cacheReads += call.cacheReads
		summary.cacheWrites += call.cacheWrites
		summary.reasoningTokens += call.reasoningTokens
		summary.cost += call.cost
		summary.estimated ||= call.estimated
		if (call.modelId) {
			modelCalls.set(call.modelId, (modelCalls.get(call.modelId) ?? 0) + 1)
		}
	}
	const prompt = promptTokens(summary)
	if (prompt > 0) {
		summary.cacheHitRate = summary.cacheReads / prompt
	}
	summary.models = [...modelCalls].map(([modelId, count]) => ({ modelId, calls: count }))
	return summary
}

/** Compact token count: 812, 18.6k, 3.9M. */
export function formatTokens(count: number): string {
	if (count >= 1e9) {
		return `${(count / 1e9).toFixed(1)}B`
	}
	if (count >= 1e6) {
		return `${(count / 1e6).toFixed(1)}M`
	}
	if (count >= 1e4) {
		return `${Math.round(count / 1e3)}k`
	}
	if (count >= 1e3) {
		return `${(count / 1e3).toFixed(1)}k`
	}
	return String(Math.round(count))
}

export function formatCost(cost: number): string {
	if (cost === 0) {
		return "$0"
	}
	return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`
}

export function formatPercent(rate: number): string {
	return `${(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)}%`
}

type SideUsageSource = ClineSubagentUsageInfo["source"]

/** Usage that does not come from the main agent's calls, for one source: its row count, tokens and cost. */
export interface SideUsage {
	source: SideUsageSource
	label: string
	rows: number
	tokens: number
	cost: number
	estimated: boolean
}

// Shown in this order, each on its own line.
const SIDE_USAGE_LABELS: Record<SideUsageSource, string> = {
	subagents: "Sub-agents",
	advisor: "Advisor",
	compaction: "Compaction",
	vision: "Image descriptions",
}

/**
 * Usage the per-call bars leave out (subagent_usage rows), one entry per source that has any:
 * sub-agent runs, advisor calls, the compaction summarizer's calls and the router's image
 * descriptions (one row per image).
 */
export function getSideUsage(messages: ClineMessage[]): SideUsage[] {
	const bySource = new Map<SideUsageSource, SideUsage>()
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
		const source: SideUsageSource = info.source && info.source in SIDE_USAGE_LABELS ? info.source : "subagents"
		const side = bySource.get(source) ?? {
			source,
			label: SIDE_USAGE_LABELS[source],
			rows: 0,
			tokens: 0,
			cost: 0,
			estimated: false,
		}
		side.rows += 1
		side.tokens += (info.tokensIn ?? 0) + (info.tokensOut ?? 0) + (info.cacheReads ?? 0) + (info.cacheWrites ?? 0)
		side.cost += info.cost ?? 0
		side.estimated ||= info.estimated === true
		bySource.set(source, side)
	}
	return (Object.keys(SIDE_USAGE_LABELS) as SideUsageSource[]).flatMap((source) => bySource.get(source) ?? [])
}

/**
 * The calls grouped by the model that served them, in order of first use. Router conversations
 * (FreeAuto, BalanceAuto) mix several models; a call whose row names no model counts under
 * `fallbackModelId` (the conversation's selected model).
 */
export function groupCallsByModel(
	calls: ApiCallUsage[],
	fallbackModelId: string | undefined,
): { modelId: string; calls: ApiCallUsage[] }[] {
	const groups = new Map<string, ApiCallUsage[]>()
	for (const call of calls) {
		const modelId = callModelId(call, fallbackModelId)
		const group = groups.get(modelId)
		if (group) {
			group.push(call)
		} else {
			groups.set(modelId, [call])
		}
	}
	return [...groups].map(([modelId, groupCalls]) => ({ modelId, calls: groupCalls }))
}

export function callModelId(call: ApiCallUsage, fallbackModelId: string | undefined): string {
	return call.modelId ?? fallbackModelId ?? ""
}
