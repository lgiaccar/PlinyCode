import type { Mode } from "@shared/storage/types"
import { useState } from "react"
import styled from "styled-components"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// Each mode has its own color: the selected segment of the switch and the outline of the focused prompt box use it.
// Plan is yellow, Agent (the "act" mode) red and Ask green. Ask's green is fixed rather than taken from the theme:
// the theme token it used to borrow (statusBarItem.remoteBackground) is blue in VS Code's current default themes.
const PLAN_MODE_COLOR = "var(--vscode-activityWarningBadge-background)"
const ACT_MODE_COLOR = "var(--vscode-statusBarItem-errorBackground, #c72e0f)"
const ASK_MODE_COLOR = "#16825d"

/** The modes, in the order the switch shows them and the shortcut cycles through them. */
const MODES: readonly Mode[] = ["plan", "act", "ask"]

const MODE_DETAILS: Record<Mode, { label: string; color: string; description: string }> = {
	plan: { label: "Plan", color: PLAN_MODE_COLOR, description: "gather information to architect a plan" },
	act: { label: "Agent", color: ACT_MODE_COLOR, description: "complete the task immediately" },
	ask: { label: "Ask", color: ASK_MODE_COLOR, description: "answer your questions without editing any file" },
}

export function modeColor(mode: Mode): string {
	return MODE_DETAILS[mode].color
}

/** The mode the keyboard shortcut switches to from `mode`. */
export function nextMode(mode: Mode): Mode {
	return MODES[(MODES.indexOf(mode) + 1) % MODES.length]
}

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
	shouldForwardProp: (prop) => !["index", "color"].includes(prop),
})<{ index: number; color: string }>`
	position: absolute;
	height: 100%;
	width: ${100 / MODES.length}%;
	background-color: ${(props) => props.color};
	transition: transform 0.2s ease;
	transform: translateX(${(props) => props.index * 100}%);
`

interface ModeSwitchProps {
	mode: Mode
	onModeSelect: (mode: Mode) => void
	togglePlanActKeys: string
}

/**
 * The Plan/Agent/Ask mode switch (the Agent segment is the "act" mode): one segment per mode, with a tooltip
 * explaining what the hovered mode does and the keyboard shortcut that cycles
 * through them. `shownTooltipMode` tracks which segment the pointer is
 * hovering, purely to decide the tooltip's copy — it's local to this component
 * since nothing outside it needs that value.
 */
export function ModeSwitch({ mode, onModeSelect, togglePlanActKeys }: ModeSwitchProps) {
	const [shownTooltipMode, setShownTooltipMode] = useState<Mode | null>(null)

	return (
		<Tooltip>
			<TooltipContent className="text-xs px-2 flex flex-col gap-1" hidden={shownTooltipMode === null} side="top">
				{shownTooltipMode &&
					`In ${MODE_DETAILS[shownTooltipMode].label} mode, PlinyCode will ${MODE_DETAILS[shownTooltipMode].description}`}
				<p className="text-description/80 text-xs mb-0">
					Switch w/ <kbd className="text-muted-foreground mx-1">{togglePlanActKeys}</kbd>
				</p>
			</TooltipContent>
			<TooltipTrigger>
				<SwitchContainer data-testid="mode-switch" disabled={false}>
					<Slider color={modeColor(mode)} index={MODES.indexOf(mode)} />
					{MODES.map((m) => (
						<div
							aria-checked={mode === m}
							className={cn(
								"pt-0.5 pb-px px-2 z-10 text-xs w-1/3 text-center bg-transparent",
								mode === m ? "text-white" : "text-input-foreground",
							)}
							key={m}
							onClick={() => onModeSelect(m)}
							onMouseLeave={() => setShownTooltipMode(null)}
							onMouseOver={() => setShownTooltipMode(m)}
							role="switch">
							{MODE_DETAILS[m].label}
						</div>
					))}
				</SwitchContainer>
			</TooltipTrigger>
		</Tooltip>
	)
}
