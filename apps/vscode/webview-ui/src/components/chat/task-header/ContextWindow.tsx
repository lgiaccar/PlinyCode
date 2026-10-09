import type { ClineContextBreakdown } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/cline/common"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import debounce from "debounce"
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Progress } from "@/components/ui/progress"
import { SlashServiceClient } from "@/services/grpc-client"
import { formatLargeNumber as formatTokenNumber } from "@/utils/format"
import CompactTaskButton from "./buttons/CompactTaskButton"
import { ContextWindowSummary } from "./ContextWindowSummary"

// Type definitions
interface ContextWindowInfoProps {
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	size?: number
}

interface ContextWindowProgressProps extends ContextWindowInfoProps {
	useAutoCondense: boolean
	lastApiReqTotalTokens?: number
	contextWindow?: number
	/**
	 * Where auto-condense runs, as a share of the context window (0 to 1): 90%
	 * of the model's input limit, which is below the window for the routers.
	 * Drawn as a marker on the bar; undefined draws none.
	 */
	autoCompactThreshold?: number
	hasEstimatedUsage?: boolean
	contextBreakdown?: ClineContextBreakdown
	onSendMessage?: (command: string, files: string[], images: string[]) => void
}

const ConfirmationDialog = memo<{
	onConfirm: (e: React.MouseEvent) => void
	onCancel: (e: React.MouseEvent) => void
}>(({ onConfirm, onCancel }) => (
	<div className="mt-2 flex flex-col gap-2 rounded-sm border border-border-panel bg-code p-2 text-sm">
		<span className="font-semibold">Compact the current task?</span>
		<span className="text-xs text-description">
			Replaces the conversation history with a summary to free up context window space.
		</span>
		<span className="flex justify-end gap-1.5">
			<VSCodeButton
				appearance="secondary"
				className="text-sm"
				onClick={onCancel}
				title="No, keep the task as is"
				type="button">
				Cancel
			</VSCodeButton>
			<VSCodeButton
				appearance="primary"
				autoFocus={true}
				className="text-sm"
				onClick={onConfirm}
				title="Yes, compact the task"
				type="button">
				Compact
			</VSCodeButton>
		</span>
	</div>
))
ConfirmationDialog.displayName = "ConfirmationDialog"

const ContextWindow: React.FC<ContextWindowProgressProps> = ({
	contextWindow = 0,
	lastApiReqTotalTokens = 0,
	autoCompactThreshold,
	onSendMessage,
	useAutoCondense,
	tokensIn,
	tokensOut,
	cacheWrites,
	cacheReads,
	hasEstimatedUsage,
	contextBreakdown,
}) => {
	const [isOpened, setIsOpened] = useState(false)
	const [confirmationNeeded, setConfirmationNeeded] = useState(false)
	const progressBarRef = useRef<HTMLDivElement>(null)

	const handleCompactClick = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault()
			e.stopPropagation()
			setConfirmationNeeded(!confirmationNeeded)
		},
		[confirmationNeeded],
	)

	const handleConfirm = useCallback((e: React.MouseEvent) => {
		e.preventDefault()
		e.stopPropagation()
		// Trigger a real SDK manual compaction rather than sending the literal
		// text "/compact" to the model (which it would treat as a normal prompt
		// and improvise a fake summary — CLINE-2503). The condense RPC runs the
		// same SDK compaction effect as the CLI's `/compact` command.
		SlashServiceClient.condense(StringRequest.create({ value: "compact" })).catch((err) =>
			console.error("Failed to compact task:", err),
		)
		setConfirmationNeeded(false)
	}, [])

	const handleCancel = useCallback((e: React.MouseEvent) => {
		e.preventDefault()
		e.stopPropagation()
		setConfirmationNeeded(false)
	}, [])

	const tokenData = useMemo(() => {
		if (!contextWindow) {
			return null
		}
		return {
			percentage: (lastApiReqTotalTokens / contextWindow) * 100,
			max: contextWindow,
			used: lastApiReqTotalTokens,
		}
	}, [contextWindow, lastApiReqTotalTokens])

	const debounceCloseHover = useCallback((e: React.MouseEvent) => {
		e.preventDefault()
		e.stopPropagation()
		const showHover = debounce((open: boolean) => setIsOpened(open), 100)

		return showHover(false)
	}, [])

	const handleFocus = useCallback(() => {
		setIsOpened(true)
	}, [])

	// Close tooltip when clicking outside
	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Element
			const isInsideProgressBar = progressBarRef.current?.contains(target as Node)

			// Check if click is inside any tooltip content by looking for our custom class
			const isInsideTooltipContent = target.closest(".context-window-tooltip-content") !== null

			if (!isInsideProgressBar && !isInsideTooltipContent) {
				setIsOpened(false)
			}
		}

		if (isOpened) {
			document.addEventListener("mousedown", handleClickOutside)
			return () => document.removeEventListener("mousedown", handleClickOutside)
		}
	}, [isOpened])

	if (!tokenData) {
		return null
	}

	return (
		<div className="flex flex-col mt-1.5" onMouseLeave={debounceCloseHover}>
			<div className="flex gap-1 flex-row @max-xs:flex-col @max-xs:items-start items-center text-sm">
				<div className="flex items-center gap-1.5 flex-1 whitespace-nowrap">
					<span className="cursor-pointer text-sm" title="Current tokens used in this request">
						{hasEstimatedUsage ? "~" : ""}
						{formatTokenNumber(tokenData.used)}
					</span>
					<div className="flex relative items-center gap-1 flex-1 w-full h-full" onMouseEnter={() => setIsOpened(true)}>
						<HoverCard>
							<HoverCardContent className="bg-menu rounded-xs shadow-sm">
								<ContextWindowSummary
									autoCompactThreshold={autoCompactThreshold}
									cacheReads={cacheReads}
									cacheWrites={cacheWrites}
									contextBreakdown={contextBreakdown}
									contextWindow={tokenData.max}
									hasEstimatedUsage={hasEstimatedUsage}
									percentage={tokenData.percentage}
									tokensIn={tokensIn}
									tokensOut={tokensOut}
									tokenUsed={tokenData.used}
								/>
							</HoverCardContent>
							<HoverCardTrigger asChild>
								{/* TODO: Re-add role="slider", aria-value*, onKeyDown, onClick, and tabIndex
								    when click-to-set-threshold is implemented. See PR #9348 for context. */}
								<div
									className="relative w-full text-foreground context-window-progress brightness-100"
									onFocus={handleFocus}
									ref={progressBarRef}>
									<Progress
										aria-label="Context window usage progress"
										color="success"
										value={tokenData.percentage}
									/>
									{autoCompactThreshold !== undefined &&
										autoCompactThreshold > 0 &&
										autoCompactThreshold < 1 && (
											<div
												aria-label="Auto condense threshold"
												className="absolute top-0 bottom-0 w-px bg-foreground opacity-60 pointer-events-none"
												data-testid="auto-compact-threshold"
												style={{ left: `${(autoCompactThreshold * 100).toFixed(1)}%` }}
												title={`Auto condense runs at about ${formatTokenNumber(Math.round(autoCompactThreshold * tokenData.max))} tokens`}
											/>
										)}
									{isOpened}
								</div>
							</HoverCardTrigger>
						</HoverCard>
					</div>
					<span className="cursor-pointer text-sm" title="Maximum context window size for this model">
						{formatTokenNumber(tokenData.max)}
					</span>
				</div>
				<CompactTaskButton onClick={handleCompactClick} />
			</div>
			{confirmationNeeded && <ConfirmationDialog onCancel={handleCancel} onConfirm={handleConfirm} />}
		</div>
	)
}

export default memo(ContextWindow)
