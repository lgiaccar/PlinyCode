import { DEFAULT_PLAN_EXECUTION_CHOICE, type PlanExecutionChoice } from "@shared/planExecution"
import { PLINY_PROVIDER_ID } from "@shared/pliny"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { memo, useEffect, useMemo, useRef, useState } from "react"
import { buildPlanExecutionMenu } from "@/components/chat/chat-view/utils/planExecution"
import { usePlinyUnlockPaidModels } from "@/components/settings/utils/plinyModelFilter"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"

interface ExecutePlanButtonProps {
	/** Switches to act mode and runs the plan on the model `choice` names. */
	onExecute: (choice: PlanExecutionChoice) => void
}

/**
 * Split button under a finished plan. The main part executes the plan on the
 * remembered choice (`plinycode.plan.executeWith`) and always names the model,
 * so what a click costs is never a surprise. The arrow opens "Execute with…":
 * picking a model there executes on it, and the extension remembers the pick
 * as the new default.
 *
 * The plan is a set of files, so a strong model can write it and a cheaper one
 * can carry it out; this is where the user makes that handoff.
 */
const ExecutePlanButton = memo(({ onExecute }: ExecutePlanButtonProps) => {
	const { apiConfiguration, planExecutionChoice, providerModelsByProvider } = useExtensionState()
	const [paidModelsUnlocked] = usePlinyUnlockPaidModels()
	const [isOpen, setIsOpen] = useState(false)
	const containerRef = useRef<HTMLDivElement>(null)

	// Read from state rather than useProviderModels: that hook refetches the
	// catalog on mount, and chat rows mount and unmount as the list scrolls. The
	// model picker under the input keeps the catalog loaded.
	const models = providerModelsByProvider?.[PLINY_PROVIDER_ID]?.models
	const { current, options } = useMemo(
		() =>
			buildPlanExecutionMenu({
				planModelId: apiConfiguration?.planModeApiModelId,
				actModelId: apiConfiguration?.actModeApiModelId,
				models: models ?? {},
				remembered: planExecutionChoice ?? DEFAULT_PLAN_EXECUTION_CHOICE,
				paidModelsUnlocked,
			}),
		[
			apiConfiguration?.planModeApiModelId,
			apiConfiguration?.actModeApiModelId,
			models,
			planExecutionChoice,
			paidModelsUnlocked,
		],
	)

	useEffect(() => {
		if (!isOpen) {
			return
		}
		const closeOnOutsideClick = (event: MouseEvent) => {
			if (!containerRef.current?.contains(event.target as Node)) {
				setIsOpen(false)
			}
		}
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setIsOpen(false)
			}
		}
		document.addEventListener("mousedown", closeOnOutsideClick)
		document.addEventListener("keydown", closeOnEscape)
		return () => {
			document.removeEventListener("mousedown", closeOnOutsideClick)
			document.removeEventListener("keydown", closeOnEscape)
		}
	}, [isOpen])

	return (
		<div className="relative ml-auto flex min-w-0 max-w-full" ref={containerRef}>
			<Button
				className="min-w-0 rounded-r-none"
				onClick={() => onExecute(current.choice)}
				size="sm"
				title={`Switch to act mode and run the plan on ${current.modelLabel} (${current.modelId})`}
				type="button">
				<span className="truncate">Execute plan · {current.modelLabel}</span>
			</Button>
			<Button
				aria-expanded={isOpen}
				aria-haspopup="menu"
				aria-label="Execute with another model"
				className="shrink-0 rounded-l-none border-0 border-l border-solid border-l-button-separator px-1 [&_svg]:size-3"
				onClick={() => setIsOpen((open) => !open)}
				size="sm"
				title="Execute with another model"
				type="button">
				<ChevronDownIcon />
			</Button>
			{isOpen && (
				// Opens upward: the plan is usually the last row, right above the
				// input, where a menu opening downward would be clipped.
				<div
					aria-label="Execute with"
					className="absolute right-0 bottom-[calc(100%+4px)] z-50 w-max max-w-[min(22rem,calc(100vw-2rem))] rounded-sm border border-solid border-menu-border bg-menu py-1 text-menu-foreground shadow-md"
					role="menu">
					<div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-description">
						Execute with…
					</div>
					{options.map((option) => {
						// By model, not by choice: the remembered choice has no row of
						// its own when an earlier row already runs the same model.
						const isCurrent = option.modelId === current.modelId
						return (
							<button
								aria-checked={isCurrent}
								className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-2 py-1 text-left text-xs text-inherit hover:bg-list-hover"
								key={option.choice}
								onClick={() => {
									setIsOpen(false)
									onExecute(option.choice)
								}}
								role="menuitemradio"
								title={option.modelId}
								type="button">
								<CheckIcon className={cn("size-3 shrink-0", !isCurrent && "invisible")} />
								<span className="min-w-0 truncate">{option.modelLabel}</span>
								<span className="ml-auto shrink-0 pl-3 text-description">{option.description}</span>
							</button>
						)
					})}
				</div>
			)}
		</div>
	)
})

ExecutePlanButton.displayName = "ExecutePlanButton"

export default ExecutePlanButton
