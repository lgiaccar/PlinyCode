import type { ClineMessage } from "@shared/ExtensionMessage"
import { isPlinyBalanceAutoModelId, isPlinyFreeAutoModelId, PLINY_PROVIDER_ID } from "@shared/pliny"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import React, { useCallback, useMemo, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import {
	type ApiCallSummary,
	type ApiCallUsage,
	callModelId,
	formatCost,
	formatPercent,
	formatTokens,
	getApiCallUsages,
	getSideUsage,
	groupCallsByModel,
	promptTokens,
	summarizeApiCalls,
} from "./tokenUsage"

/** The bars show the most recent calls; older ones still count in the totals. */
const MAX_BARS = 80

// Stacked bottom-up in this order; colours are defined in index.css (validated for colour-blind separation).
const SERIES = [
	{ key: "cacheReads", label: "Cache read", color: "var(--token-series-cache-read)" },
	{ key: "cacheWrites", label: "Cache write", color: "var(--token-series-cache-write)" },
	{ key: "tokensIn", label: "Input", color: "var(--token-series-input)" },
	{ key: "tokensOut", label: "Output", color: "var(--token-series-output)" },
] as const

// Whether the panel is folded down to its header row; remembered per webview, open by default.
const COLLAPSED_STORAGE_KEY = "plinyCode.tokenUsagePanelCollapsed"

function readCollapsed(): boolean {
	try {
		return globalThis.localStorage?.getItem(COLLAPSED_STORAGE_KEY) === "true"
	} catch {
		return false
	}
}

function writeCollapsed(collapsed: boolean): void {
	try {
		globalThis.localStorage?.setItem(COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false")
	} catch {
		// localStorage can be unavailable; the state then lasts until the webview reloads.
	}
}

interface TokenUsagePanelProps {
	clineMessages: ClineMessage[]
	/** The conversation's selected model, used to name calls whose row carries no model. */
	selectedModelId?: string
	showCost: boolean
}

function shortModelId(modelId: string): string {
	const slash = modelId.lastIndexOf("/")
	return slash >= 0 ? modelId.slice(slash + 1) : modelId
}

/**
 * Per-call token usage under the context bar: one stacked bar per LLM call (cache read, cache
 * write, uncached input, output) and a text summary of the whole conversation. Hovering a bar
 * switches the summary to that call. When the conversation used several models (the FreeAuto and
 * BalanceAuto routers pick one per call), a chip per model narrows the summary to that model's
 * calls and dims the other bars. The header row folds the panel away.
 */
const TokenUsagePanel: React.FC<TokenUsagePanelProps> = ({ clineMessages, selectedModelId, showCost }) => {
	const { providerModelsByProvider } = useExtensionState()
	const plinyModels = providerModelsByProvider?.[PLINY_PROVIDER_ID]?.models
	const calls = useMemo(() => getApiCallUsages(clineMessages), [clineMessages])
	const summary = useMemo(() => summarizeApiCalls(calls), [calls])
	const side = useMemo(() => getSideUsage(clineMessages), [clineMessages])
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
	const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null)
	const [collapsed, setCollapsed] = useState(readCollapsed)
	const modelGroups = useMemo(() => groupCallsByModel(calls, selectedModelId), [calls, selectedModelId])
	// A selection that no longer matches a group (e.g. another conversation opened) shows everything.
	const selectedGroup = modelGroups.find((group) => group.modelId === selectedModelKey)
	const selectedSummary = useMemo(() => (selectedGroup ? summarizeApiCalls(selectedGroup.calls) : undefined), [selectedGroup])

	const toggleCollapsed = useCallback(() => {
		setCollapsed((previous) => {
			writeCollapsed(!previous)
			return !previous
		})
	}, [])

	const modelLabel = (modelId: string | undefined): string => {
		const id = modelId ?? selectedModelId
		if (!id) {
			return "Unknown model"
		}
		if (isPlinyFreeAutoModelId(id)) {
			return "FreeAuto"
		}
		if (isPlinyBalanceAutoModelId(id)) {
			return "BalanceAuto"
		}
		return plinyModels?.[id]?.name || shortModelId(id)
	}

	if (calls.length === 0) {
		return null
	}

	const firstShown = Math.max(0, calls.length - MAX_BARS)
	const shown = calls.slice(firstShown)
	const maxTotal = Math.max(1, ...shown.map((call) => promptTokens(call) + call.tokensOut))
	const hoveredCall = hoveredIndex !== null ? calls[hoveredIndex] : undefined
	const hovered = hoveredCall && hoveredIndex !== null ? { call: hoveredCall, number: hoveredIndex + 1 } : undefined

	const multiModel = modelGroups.length > 1
	const usage = selectedSummary ?? summary

	return (
		<div
			className="mt-2 flex flex-col gap-1 text-xs"
			data-testid="token-usage-panel"
			onClick={(event) => event.stopPropagation()}
			onKeyDown={(event) => event.stopPropagation()}>
			<button
				aria-expanded={!collapsed}
				className="flex items-center gap-1 min-w-0 p-0 bg-transparent border-0 text-left text-description cursor-pointer hover:text-foreground"
				onClick={toggleCollapsed}
				type="button">
				{collapsed ? (
					<ChevronRightIcon className="shrink-0" size={14} />
				) : (
					<ChevronDownIcon className="shrink-0" size={14} />
				)}
				<span className="text-foreground">Token usage</span>
				<span className="truncate tabular-nums">
					<Dot />
					{summary.calls} {summary.calls === 1 ? "call" : "calls"}
					{showCost && (
						<>
							<Dot />
							{summary.estimated ? "~" : ""}
							{formatCost(summary.cost)}
						</>
					)}
					{summary.cacheHitRate !== undefined && (
						<>
							<Dot />
							Hit rate {formatPercent(summary.cacheHitRate)}
						</>
					)}
				</span>
			</button>
			{!collapsed && (
				<>
					<div
						aria-label={`Token usage per call, last ${shown.length} of ${calls.length}`}
						className="flex items-end gap-px h-8"
						onMouseLeave={() => setHoveredIndex(null)}
						role="img">
						{shown.map((call, offset) => {
							const index = firstShown + offset
							const total = promptTokens(call) + call.tokensOut
							const dimmed =
								(hoveredIndex !== null && hoveredIndex !== index) ||
								(selectedGroup !== undefined && callModelId(call, selectedModelId) !== selectedGroup.modelId)
							return (
								<div
									className={cn(
										"flex flex-col-reverse justify-start flex-1 min-w-0.5 max-w-2.5 h-full cursor-default",
										dimmed && "opacity-30",
									)}
									data-dimmed={dimmed || undefined}
									data-testid="token-usage-bar"
									key={call.ts}
									onMouseEnter={() => setHoveredIndex(index)}>
									<div
										className="flex flex-col-reverse gap-px rounded-t-[1px] overflow-hidden"
										style={{ height: `${Math.max(2, (total / maxTotal) * 100)}%` }}>
										{SERIES.map((series) =>
											call[series.key] > 0 ? (
												<div
													key={series.key}
													style={{
														flexGrow: call[series.key],
														flexBasis: 0,
														minHeight: 1,
														backgroundColor: series.color,
													}}
												/>
											) : null,
										)}
									</div>
								</div>
							)
						})}
					</div>
					<div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-description">
						{SERIES.map((series) => (
							<span className="inline-flex items-center gap-1 whitespace-nowrap" key={series.key}>
								<span className="inline-block size-2 rounded-[2px]" style={{ backgroundColor: series.color }} />
								{series.label}
							</span>
						))}
					</div>
					{multiModel && (
						<div aria-label="Filter by model" className="flex flex-wrap gap-1" role="group">
							<ModelChip active={!selectedGroup} onClick={() => setSelectedModelKey(null)}>
								All models
							</ModelChip>
							{modelGroups.map((group) => (
								<ModelChip
									active={selectedGroup?.modelId === group.modelId}
									key={group.modelId}
									onClick={() =>
										setSelectedModelKey(selectedGroup?.modelId === group.modelId ? null : group.modelId)
									}>
									{modelLabel(group.modelId || undefined)} ×{group.calls.length}
								</ModelChip>
							))}
						</div>
					)}
					{hovered ? (
						<UsageLines
							caption={`Call ${hovered.number} of ${calls.length}`}
							model={modelLabel(hovered.call.modelId)}
							showCost={showCost}
							usage={{ ...hovered.call, calls: 1, cacheHitRate: hitRate(hovered.call), models: [] }}
						/>
					) : (
						<UsageLines
							caption={
								selectedGroup
									? `${usage.calls} of ${summary.calls} calls`
									: `${usage.calls} ${usage.calls === 1 ? "call" : "calls"}`
							}
							model={
								selectedGroup
									? modelLabel(selectedGroup.modelId || undefined)
									: multiModel
										? `${modelGroups.length} models`
										: modelLabel(modelGroups[0]?.modelId || undefined)
							}
							showCost={showCost}
							side={!selectedGroup && side.rows > 0 ? side : undefined}
							usage={usage}
						/>
					)}
				</>
			)}
		</div>
	)
}

const ModelChip: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
	active,
	onClick,
	children,
}) => (
	<button
		aria-pressed={active}
		className={cn(
			"px-1.5 py-px rounded-xs border text-xs cursor-pointer whitespace-nowrap max-w-full truncate",
			active
				? "bg-(--vscode-badge-background) text-(--vscode-badge-foreground) border-transparent"
				: "bg-transparent text-description border-(--vscode-panel-border) hover:text-foreground",
		)}
		onClick={onClick}
		type="button">
		{children}
	</button>
)

function hitRate(call: ApiCallUsage): number | undefined {
	const prompt = promptTokens(call)
	return prompt > 0 ? call.cacheReads / prompt : undefined
}

const UsageLines: React.FC<{
	caption: string
	model: string
	usage: Omit<ApiCallSummary, "models"> & { models?: ApiCallSummary["models"] }
	showCost: boolean
	side?: { rows: number; tokens: number; cost: number }
}> = ({ caption, model, usage, showCost, side }) => {
	const approx = usage.estimated ? "~" : ""
	return (
		<div className="flex flex-col text-description tabular-nums leading-snug min-w-0" data-testid="token-usage-lines">
			<div className="text-foreground truncate" title={model}>
				{model}
			</div>
			<div>
				{caption}
				{showCost && (
					<>
						<Dot />
						{approx}
						{formatCost(usage.cost)}
					</>
				)}
			</div>
			<div>
				In {approx}
				{formatTokens(usage.tokensIn)}
				<Dot />
				Out {approx}
				{formatTokens(usage.tokensOut)}
				{usage.reasoningTokens > 0 && (
					<>
						<Dot />
						Reason {formatTokens(usage.reasoningTokens)}
					</>
				)}
			</div>
			<div>
				Cache R {formatTokens(usage.cacheReads)}
				<Dot />W {formatTokens(usage.cacheWrites)}
				{usage.cacheHitRate !== undefined && (
					<>
						<Dot />
						Hit rate {formatPercent(usage.cacheHitRate)}
					</>
				)}
			</div>
			{side && (
				<div>
					+ sub-agents and advisor: {formatTokens(side.tokens)} tokens
					{showCost && (
						<>
							<Dot />
							{formatCost(side.cost)}
						</>
					)}
				</div>
			)}
		</div>
	)
}

const Dot = () => <span className="opacity-60 whitespace-pre">{" · "}</span>

export default TokenUsagePanel
