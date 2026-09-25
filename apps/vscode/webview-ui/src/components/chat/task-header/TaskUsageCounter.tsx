import { ClockIcon } from "lucide-react"
import { useEffect, useState } from "react"
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
}: TaskUsageCounterProps) => {
	const [now, setNow] = useState(() => Date.now())

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
				</>
			)}
		</div>
	)
}

export default TaskUsageCounter
