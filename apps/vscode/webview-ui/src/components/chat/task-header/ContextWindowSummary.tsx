import type { ClineContextBreakdown } from "@shared/ExtensionMessage"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import React, { memo, useCallback, useMemo, useState } from "react"
import { formatLargeNumber as formatTokenNumber } from "@/utils/format"

interface TokenUsageInfoProps {
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
}

interface TokenDetail {
	title: string
	value?: number
	icon: string
}

interface TaskContextWindowButtonsProps extends TokenUsageInfoProps {
	percentage: number
	tokenUsed: number
	contextWindow: number
	autoCompactThreshold?: number
	isThresholdChanged?: boolean
	isThresholdFadingOut?: boolean
	hasEstimatedUsage?: boolean
	contextBreakdown?: ClineContextBreakdown
}

const CONTEXT_BREAKDOWN_LABELS: Record<keyof ClineContextBreakdown, string> = {
	systemPrompt: "System Prompt",
	rules: "Rules",
	skills: "Skills",
	workflows: "Workflows",
	conversation: "Conversation",
	other: "Other",
}

const ContextBreakdownDetails = memo<{ breakdown: ClineContextBreakdown }>(({ breakdown }) => {
	const rows = useMemo(() => {
		const total = Object.values(breakdown).reduce((sum, value) => sum + (value ?? 0), 0)
		return (Object.keys(CONTEXT_BREAKDOWN_LABELS) as Array<keyof ClineContextBreakdown>)
			.map((key) => ({ key, label: CONTEXT_BREAKDOWN_LABELS[key], value: breakdown[key] }))
			.filter((row) => (row.value ?? 0) > 0)
			.map((row) => ({
				...row,
				percentage: total > 0 ? ((row.value ?? 0) / total) * 100 : 0,
			}))
	}, [breakdown])

	if (rows.length === 0) {
		return <div>No context breakdown available</div>
	}

	return (
		<div className="space-y-1">
			{rows.map((row) => (
				<div className="flex justify-between" key={row.key}>
					<span>{row.label}</span>
					<span className="font-mono">
						{formatTokenNumber(row.value ?? 0)} ({row.percentage.toFixed(0)}%)
					</span>
				</div>
			))}
		</div>
	)
})
ContextBreakdownDetails.displayName = "ContextBreakdownDetails"

// New accordion item component
const AccordionItem = memo<{
	title: string
	value: React.ReactNode
	isExpanded: boolean
	onToggle: (event?: React.MouseEvent) => void
	children?: React.ReactNode
}>(({ title, value, isExpanded, onToggle, children }) => {
	const handleClick = useCallback(
		(event: React.MouseEvent) => {
			event.preventDefault()
			event.stopPropagation()
			onToggle(event)
		},
		[onToggle],
	)

	return (
		<div className="flex flex-col w-full">
			<div
				className="flex justify-between items-center gap-1 cursor-pointer hover:bg-foreground/5 rounded p-0.5 transition-colors w-full"
				onClick={handleClick}>
				<div className="flex items-center gap-1">
					{isExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
					<div className="font-semibold">{title}</div>
				</div>
				<div className="text-muted-foreground">{value}</div>
			</div>
			{isExpanded && children && <div className="ml-5 my-1 text-xs text-muted-foreground">{children}</div>}
		</div>
	)
})
AccordionItem.displayName = "AccordionItem"

// Constants
const TOKEN_DETAILS_CONFIG: Omit<TokenDetail, "value">[] = [
	{ title: "Prompt Tokens", icon: "codicon-arrow-up" },
	{ title: "Completion Tokens", icon: "codicon-arrow-down" },
	{ title: "Cache Writes", icon: "codicon-arrow-left" },
	{ title: "Cache Reads", icon: "codicon-arrow-right" },
]

const TokenUsageDetails = memo<TokenUsageInfoProps>(({ tokensIn, tokensOut, cacheWrites, cacheReads }) => {
	const contextTokenDetails = useMemo(() => {
		const values = [tokensIn, tokensOut, cacheWrites || 0, cacheReads || 0]
		return TOKEN_DETAILS_CONFIG.map((config, index) => ({ ...config, value: values[index] })).filter((item) => item.value)
	}, [tokensIn, tokensOut, cacheWrites, cacheReads])

	if (!tokensIn) {
		return <div>No token usage data available</div>
	}

	return (
		<div className="space-y-1">
			{contextTokenDetails.map((item) => (
				<div className="flex justify-between">
					<span>{item.title}</span>
					<span className="font-mono">{formatTokenNumber(item.value || 0)}</span>
				</div>
			))}
		</div>
	)
})
TokenUsageDetails.displayName = "TokenUsageDetails"

export const ContextWindowSummary: React.FC<TaskContextWindowButtonsProps> = ({
	contextWindow,
	tokenUsed,
	tokensIn,
	tokensOut,
	cacheWrites,
	cacheReads,
	percentage,
	autoCompactThreshold = 0,
	hasEstimatedUsage,
	contextBreakdown,
}) => {
	// Accordion state
	const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set())

	const toggleSection = useCallback((section: string, event?: React.MouseEvent) => {
		if (event) {
			event.preventDefault()
			event.stopPropagation()
		}
		setExpandedSections((prev) => {
			const newSet = new Set(prev)
			if (newSet.has(section)) {
				newSet.delete(section)
			} else {
				newSet.add(section)
			}
			return newSet
		})
	}, [])

	const totalTokens = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)

	return (
		<div className="context-window-tooltip-content flex flex-col gap-2 bg-menu rounded shadow-sm z-100 w-60 p-1">
			{autoCompactThreshold > 0 && (
				<AccordionItem
					isExpanded={expandedSections.has("threshold")}
					onToggle={(event) => toggleSection("threshold", event)}
					title="Auto Condense Threshold"
					value={<span className="text-muted-foreground">{`${(autoCompactThreshold * 100).toFixed(0)}%`}</span>}>
					<div className="space-y-1">
						<p className="text-xs leading-relaxed text-white">
							Click on the context window bar to set a new threshold.
						</p>
						<p className="text-xs leading-relaxed mt-0 mb-0">
							When the context window usage exceeds this threshold, the task will be automatically condensed.
						</p>
					</div>
				</AccordionItem>
			)}

			<AccordionItem
				isExpanded={expandedSections.has("context")}
				onToggle={(event) => toggleSection("context", event)}
				title="Context Window"
				value={
					percentage ? `${hasEstimatedUsage ? "~" : ""}${percentage.toFixed(1)}%` : formatTokenNumber(contextWindow)
				}>
				<div className="space-y-1">
					<div className="flex justify-between">
						<span>Used:</span>
						<span className="font-mono">
							{hasEstimatedUsage ? "~" : ""}
							{formatTokenNumber(tokenUsed)}
						</span>
					</div>
					<div className="flex justify-between">
						<span>Total:</span>
						<span className="font-mono">{formatTokenNumber(contextWindow)}</span>
					</div>
					<div className="flex justify-between">
						<span>Remaining:</span>
						<span className="font-mono">{formatTokenNumber(contextWindow - tokenUsed)}</span>
					</div>
				</div>
			</AccordionItem>

			{totalTokens > 0 && (
				<AccordionItem
					isExpanded={expandedSections.has("tokens")}
					onToggle={(event) => toggleSection("tokens", event)}
					title="Token Usage"
					value={`${hasEstimatedUsage ? "~" : ""}${formatTokenNumber(totalTokens)}`}>
					<TokenUsageDetails
						cacheReads={cacheReads}
						cacheWrites={cacheWrites}
						tokensIn={tokensIn}
						tokensOut={tokensOut}
					/>
				</AccordionItem>
			)}

			{contextBreakdown && Object.values(contextBreakdown).some((value) => (value ?? 0) > 0) && (
				<AccordionItem
					isExpanded={expandedSections.has("breakdown")}
					onToggle={(event) => toggleSection("breakdown", event)}
					title="Context Breakdown"
					value="">
					<ContextBreakdownDetails breakdown={contextBreakdown} />
				</AccordionItem>
			)}
		</div>
	)
}
