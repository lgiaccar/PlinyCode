import { ClockIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { formatDuration, formatLargeNumber, formatStartTime } from "@/utils/format"

interface TaskUsageCounterProps {
	/** When the conversation started (ms since epoch). */
	startedTs?: number
	/** Running time of finished runs (ms). */
	activeMs?: number
	/** When the run in progress started; the time ticks while it is set. */
	runningSinceTs?: number
	tokensIn: number
	tokensOut: number
	cacheWrites?: number
	cacheReads?: number
	/** Cost so far in USD; left out when the provider reports no real cost. */
	totalCost?: number
	/** True when a request in the totals used an estimated token count. */
	hasEstimatedUsage?: boolean
	/**
	 * The conversation's budget in USD (0 = no limit), shown after the cost as
	 * `$cost / $budget`. Left out for free models, which are never limited.
	 */
	budget?: number
	/** Called with a new budget the user typed; the budget is read-only without it. */
	onBudgetChange?: (budget: number) => void
}

const formatBudget = (budget: number) => (budget > 0 ? `$${budget.toFixed(2)}` : "no limit")

/** Parses a typed budget: dollars, with or without "$"; blank means 0 (no limit). Undefined when invalid. */
export function parseBudget(text: string): number | undefined {
	const trimmed = text.trim().replace(/^\$/, "")
	if (trimmed === "") {
		return 0
	}
	const value = Number(trimmed)
	return Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Inline editor for the budget: Enter or blur saves, Escape cancels, an invalid amount is dropped. */
const BudgetInput = ({
	budget,
	onCommit,
	onDone,
}: {
	budget: number
	onCommit: (budget: number) => void
	onDone: () => void
}) => {
	const [value, setValue] = useState(budget > 0 ? budget.toFixed(2) : "0")
	const inputRef = useRef<HTMLInputElement>(null)
	const finishedRef = useRef(false)

	useEffect(() => {
		inputRef.current?.focus()
		inputRef.current?.select()
	}, [])

	const finish = (save: boolean) => {
		if (finishedRef.current) {
			return
		}
		finishedRef.current = true
		const parsed = parseBudget(value)
		if (save && parsed !== undefined && parsed !== budget) {
			onCommit(parsed)
		}
		onDone()
	}

	return (
		<input
			aria-label="Conversation budget in USD (0 = no limit)"
			className="w-14 rounded-xs border border-(--vscode-focusBorder) bg-(--vscode-input-background) px-1 text-xs text-(--vscode-input-foreground) outline-none tabular-nums"
			inputMode="decimal"
			onBlur={() => finish(true)}
			onChange={(e) => setValue(e.target.value)}
			onClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => {
				e.stopPropagation()
				if (e.key === "Enter") {
					e.preventDefault()
					finish(true)
				} else if (e.key === "Escape") {
					e.preventDefault()
					finish(false)
				}
			}}
			ref={inputRef}
			type="text"
			value={value}
		/>
	)
}

/** Every token the conversation has processed: input, output and cache traffic. */
export function totalTaskTokens({
	tokensIn,
	tokensOut,
	cacheWrites = 0,
	cacheReads = 0,
}: Pick<TaskUsageCounterProps, "tokensIn" | "tokensOut" | "cacheWrites" | "cacheReads">): number {
	return (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
}

/**
 * Live running time, token count and cost of the conversation. The time ticks
 * every second while the agent runs; tokens and cost move with each request.
 */
const TaskUsageCounter = ({
	startedTs,
	activeMs = 0,
	runningSinceTs,
	tokensIn,
	tokensOut,
	cacheWrites,
	cacheReads,
	totalCost,
	hasEstimatedUsage,
	budget,
	onBudgetChange,
}: TaskUsageCounterProps) => {
	const [now, setNow] = useState(() => Date.now())
	const [isEditingBudget, setIsEditingBudget] = useState(false)

	useEffect(() => {
		if (runningSinceTs === undefined) {
			return
		}
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [runningSinceTs])

	const totalMs = activeMs + (runningSinceTs !== undefined ? Math.max(0, now - runningSinceTs) : 0)
	const tokens = totalTaskTokens({ tokensIn, tokensOut, cacheWrites, cacheReads })
	const estimated = hasEstimatedUsage ? "~" : ""
	if (!startedTs && totalMs <= 0 && tokens <= 0 && totalCost === undefined) {
		return null
	}

	const details = [
		startedTs ? `Started ${formatStartTime(startedTs)}` : undefined,
		`Agent running time ${formatDuration(totalMs)}`,
		`${estimated}${tokens.toLocaleString("en-US")} tokens (${formatLargeNumber(tokensIn || 0)} in, ${formatLargeNumber(
			tokensOut || 0,
		)} out, ${formatLargeNumber(cacheReads || 0)} cache read, ${formatLargeNumber(cacheWrites || 0)} cache write)`,
		totalCost !== undefined ? `Cost ${estimated}$${totalCost.toFixed(4)}` : undefined,
		totalCost !== undefined && budget !== undefined ? `Budget ${formatBudget(budget)}` : undefined,
		hasEstimatedUsage ? "Based on an estimated token count; the real figures may differ" : undefined,
	].filter(Boolean)
	const title = details.join("\n")

	return (
		<div
			aria-label={details.join(" · ")}
			className="mx-1 inline-flex shrink-0 items-center gap-1 text-xs text-description tabular-nums whitespace-nowrap"
			data-testid="task-usage-counter"
			title={title}>
			<ClockIcon className="opacity-70" size={11} />
			<span>{formatDuration(totalMs)}</span>
			<span className="opacity-60">·</span>
			<span>
				{estimated}
				{formatLargeNumber(tokens)} tok
			</span>
			{totalCost !== undefined && (
				<>
					<span className="opacity-60">·</span>
					<span
						className="px-1 py-0.25 rounded-full text-badge-background bg-badge-foreground/80 text-xs"
						id="price-tag">
						{estimated}${totalCost.toFixed(4)}
					</span>
					{budget !== undefined && (
						<>
							<span className="opacity-60">/</span>
							{isEditingBudget && onBudgetChange ? (
								<BudgetInput budget={budget} onCommit={onBudgetChange} onDone={() => setIsEditingBudget(false)} />
							) : (
								<button
									aria-label={`Conversation budget ${formatBudget(budget)}${onBudgetChange ? ", click to change" : ""}`}
									className={cn(
										"border-0 bg-transparent p-0 text-xs text-description tabular-nums",
										budget > 0 && totalCost >= budget && "text-(--vscode-errorForeground)",
										onBudgetChange
											? "cursor-pointer underline decoration-dotted hover:text-foreground"
											: "cursor-default",
									)}
									data-testid="task-budget"
									disabled={!onBudgetChange}
									onClick={(e) => {
										e.stopPropagation()
										setIsEditingBudget(true)
									}}
									onKeyDown={(e) => e.stopPropagation()}
									title="This conversation's budget. PlinyCode pauses when the cost reaches it; free models are never limited. Click to change (0 = no limit)."
									type="button">
									{formatBudget(budget)}
								</button>
							)}
						</>
					)}
				</>
			)}
		</div>
	)
}

export default TaskUsageCounter
