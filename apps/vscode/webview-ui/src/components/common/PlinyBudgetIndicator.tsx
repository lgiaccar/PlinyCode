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
 * "Pliny budget: $88.08 left of $200 this month". Shown only while the
 * active provider is Pliny and the gateway reports a budget.
 */
const PlinyBudgetIndicator: React.FC<PlinyBudgetIndicatorProps> = ({ className, refreshKey }) => {
	const { apiConfiguration, mode } = useExtensionState()
	const isPliny = getModeSpecificFields(apiConfiguration, mode).apiProvider === "pliny"
	const budget = usePlinyBudget(isPliny, refreshKey)
	if (!budget) {
		return null
	}

	const period = plinyBudgetPeriodLabel(budget.period)
	const resets = budget.periodEndMs
		? `, resets ${new Date(budget.periodEndMs + 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
		: ""
	const low = budget.isBlocked || budget.percentage >= 90
	return (
		<div
			className={cn("inline-flex items-center gap-1 text-xs text-description", className)}
			title={`Pliny budget: ${usd(budget.used)} used of ${usd(budget.limit)} this ${period} (${budget.percentage.toFixed(0)}%)${resets}`}>
			<WalletIcon className="shrink-0" size={12} />
			<span className={cn({ "text-error": low })}>
				{budget.isBlocked
					? `Pliny budget exhausted (${usd(budget.limit)} this ${period})`
					: `Pliny budget: ${usd(budget.remaining)} left of ${usd(budget.limit)} this ${period}`}
			</span>
		</div>
	)
}

export default PlinyBudgetIndicator
