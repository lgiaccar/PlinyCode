import { plinyBudgetPeriodLabel } from "@shared/plinyBudget"
import { WalletIcon } from "lucide-react"
import React from "react"
import { getModeSpecificFields } from "@/components/settings/utils/providerUtils"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { usePlinyBudget } from "@/hooks/usePlinyBudget"
import { cn } from "@/lib/utils"

interface PlinyBudgetIndicatorProps {
	className?: string
	/** Changing this refetches the budget (throttled to once a minute). */
	refreshKey?: unknown
}

const usd = (value: number) => `$${value.toFixed(2)}`

/**
 * Always visible for Pliny, including loading, failure and last-known states.
 * A missing gateway response must never silently remove the account budget.
 */
const PlinyBudgetIndicator: React.FC<PlinyBudgetIndicatorProps> = ({ className, refreshKey }) => {
	const { apiConfiguration, mode } = useExtensionState()
	const isPliny = getModeSpecificFields(apiConfiguration, mode).apiProvider === "pliny"
	const { budget, loading, error, updatedAt, retry } = usePlinyBudget(isPliny, refreshKey)
	if (!isPliny) {
		return null
	}
	if (!budget) {
		return (
			<div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-description", className)}>
				<span className="inline-flex items-center gap-1" role="status">
					<WalletIcon className="shrink-0" size={12} />
					{loading || !error ? "Pliny budget: loading…" : "Pliny budget: unavailable"}
				</span>
				{error && <span className="basis-full break-words">{error}</span>}
				<button
					aria-label="Retry Pliny budget"
					className="text-link disabled:opacity-50"
					disabled={loading}
					onClick={retry}
					type="button">
					Retry
				</button>
			</div>
		)
	}

	const period = plinyBudgetPeriodLabel(budget.period)
	const resets = budget.periodEndMs
		? `, resets ${new Date(budget.periodEndMs + 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
		: ""
	const low = budget.isBlocked || budget.percentage >= 90
	return (
		<div
			className={cn("flex flex-wrap items-center gap-1 text-xs text-description", className)}
			title={`Pliny budget: ${usd(budget.used)} used of ${usd(budget.limit)} this ${period} (${budget.percentage.toFixed(0)}%)${resets}`}>
			<WalletIcon className="shrink-0" size={12} />
			<span className={cn({ "text-error": low })} role="status">
				{error ? "Last known — " : ""}
				{budget.isBlocked
					? `Pliny budget exhausted (${usd(budget.limit)} this ${period})`
					: `Pliny budget: ${usd(budget.remaining)} left of ${usd(budget.limit)} this ${period}`}
			</span>
			<button
				aria-label="Refresh Pliny budget"
				className="text-link ml-1 disabled:opacity-50"
				disabled={loading}
				onClick={retry}
				type="button">
				{loading ? "Refreshing…" : "Refresh"}
			</button>
			{error && (
				<span className="basis-full break-words">
					{error} Last updated {new Date(updatedAt).toLocaleTimeString()}.
				</span>
			)}
		</div>
	)
}

export default PlinyBudgetIndicator
