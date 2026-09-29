import type { Mode } from "@shared/storage/types"
import { useState } from "react"
import styled from "styled-components"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export const PLAN_MODE_COLOR = "var(--vscode-activityWarningBadge-background)"
const ACT_MODE_COLOR = "var(--vscode-focusBorder)"

const SwitchContainer = styled.div<{ disabled: boolean }>`
	display: flex;
	align-items: center;
	background-color: transparent;
	border: 1px solid var(--vscode-input-border);
	border-radius: 12px;
	overflow: hidden;
	cursor: ${(props) => (props.disabled ? "not-allowed" : "pointer")};
	opacity: ${(props) => (props.disabled ? 0.5 : 1)};
	transform: scale(1);
	transform-origin: right center;
	margin-left: 0;
	user-select: none; // Prevent text selection
`

const Slider = styled.div.withConfig({
	shouldForwardProp: (prop) => !["isAct", "isPlan"].includes(prop),
})<{ isAct: boolean; isPlan?: boolean }>`
	position: absolute;
	height: 100%;
	width: 50%;
	background-color: ${(props) => (props.isPlan ? PLAN_MODE_COLOR : ACT_MODE_COLOR)};
	transition: transform 0.2s ease;
	transform: translateX(${(props) => (props.isAct ? "100%" : "0%")});
`

interface ModeSwitchProps {
	mode: Mode
	onModeToggle: () => void
	togglePlanActKeys: string
}

/**
 * The Plan/Act mode toggle: a two-state switch with a tooltip explaining what
 * each mode does, and the keyboard shortcut to switch. `shownTooltipMode`
 * tracks which half of the switch the pointer is hovering, purely to decide
 * the tooltip's copy — it's local to this component since nothing outside it
 * needs that value.
 */
export function ModeSwitch({ mode, onModeToggle, togglePlanActKeys }: ModeSwitchProps) {
	const [shownTooltipMode, setShownTooltipMode] = useState<Mode | null>(null)

	return (
		<Tooltip>
			<TooltipContent className="text-xs px-2 flex flex-col gap-1" hidden={shownTooltipMode === null} side="top">
				{`In ${shownTooltipMode === "act" ? "Act" : "Plan"}  mode, PlinyCode will ${shownTooltipMode === "act" ? "complete the task immediately" : "gather information to architect a plan"}`}
				<p className="text-description/80 text-xs mb-0">
					Toggle w/ <kbd className="text-muted-foreground mx-1">{togglePlanActKeys}</kbd>
				</p>
			</TooltipContent>
			<TooltipTrigger>
				<SwitchContainer data-testid="mode-switch" disabled={false} onClick={onModeToggle}>
					<Slider isAct={mode === "act"} isPlan={mode === "plan"} />
					{["Plan", "Act"].map((m) => (
						<div
							aria-checked={mode === m.toLowerCase()}
							className={cn(
								"pt-0.5 pb-px px-2 z-10 text-xs w-1/2 text-center bg-transparent",
								mode === m.toLowerCase() ? "text-white" : "text-input-foreground",
							)}
							key={m}
							onMouseLeave={() => setShownTooltipMode(null)}
							onMouseOver={() => setShownTooltipMode(m.toLowerCase() === "plan" ? "plan" : "act")}
							role="switch">
							{m}
						</div>
					))}
				</SwitchContainer>
			</TooltipTrigger>
		</Tooltip>
	)
}
