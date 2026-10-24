import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { memo, useCallback, useEffect, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface ThinkingRowProps {
	showTitle: boolean
	reasoningContent?: string
	isVisible: boolean
	isExpanded: boolean
	onToggle?: () => void
	title?: string
	isStreaming?: boolean
	showChevron?: boolean
}

export const ThinkingRow = memo(
	({
		showTitle = false,
		reasoningContent,
		isVisible,
		isExpanded,
		onToggle,
		title = "Thinking",
		isStreaming = false,
		showChevron = true,
	}: ThinkingRowProps) => {
		const contentId = useId()
		const scrollRef = useRef<HTMLDivElement>(null)
		const [canScrollUp, setCanScrollUp] = useState(false)
		const [canScrollDown, setCanScrollDown] = useState(false)

		const checkScrollable = useCallback(() => {
			if (scrollRef.current) {
				const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
				setCanScrollUp(scrollTop > 1)
				setCanScrollDown(scrollTop + clientHeight < scrollHeight - 1)
			}
		}, [])

		// Follow new reasoning only while the user has the streaming content open.
		// Reopened, completed reasoning starts at the top.
		useEffect(() => {
			if (scrollRef.current && isVisible && isExpanded && isStreaming && reasoningContent) {
				scrollRef.current.scrollTop = scrollRef.current.scrollHeight
			}
			checkScrollable()
		}, [reasoningContent, isVisible, isExpanded, isStreaming, checkScrollable])

		if (!isVisible) {
			return null
		}

		// Don't render anything if collapsed and no title (nothing to show)
		if (!isExpanded && !showTitle) {
			return null
		}

		return (
			<div className="ml-1 pl-0 mb-0 -mt-[2px]">
				{showTitle ? (
					<Button
						aria-controls={isExpanded ? contentId : undefined}
						aria-expanded={isExpanded}
						className={cn(
							"inline-flex justify-baseline gap-0.5 text-left select-none px-0 py-0 my-0 h-auto min-h-0 w-full text-description overflow-visible focus-visible:!outline focus-visible:!outline-1 focus-visible:!outline-offset-2 focus-visible:!outline-[var(--vscode-focusBorder)]",
							{
								"cursor-pointer": !!onToggle,
								"cursor-default": !onToggle,
							},
						)}
						onClick={onToggle}
						size="icon"
						variant="icon">
						<span
							className={cn("text-[13px] leading-[1.2]", {
								"animate-shimmer bg-linear-90 from-foreground to-description bg-[length:200%_100%] bg-clip-text text-transparent":
									isStreaming,
								"select-none": isStreaming,
							})}>
							{title}
						</span>
						{showChevron &&
							(isExpanded ? (
								<ChevronDownIcon className="!size-1 text-description" />
							) : (
								<ChevronRightIcon className="!size-1 text-description" />
							))}
					</Button>
				) : null}

				{isExpanded && (
					<div
						className={cn(
							"flex gap-0 overflow-hidden w-full min-w-0 max-h-0 opacity-0 items-baseline justify-baseline text-left !p-0 !pl-0",
							{
								"max-h-[200px] opacity-100": isVisible,
								"transition-[max-height] duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] [transition:max-height_250ms_cubic-bezier(0.4,0,0.2,1),opacity_150ms_ease-out]":
									isVisible,
							},
						)}
						id={contentId}>
						<div className="relative flex-1">
							<div
								className={cn(
									"flex max-h-[150px] overflow-y-auto text-description leading-normal truncated whitespace-pre-wrap break-words pl-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden [direction:ltr]",
								)}
								onScroll={checkScrollable}
								ref={scrollRef}>
								<span className="pb-2 block text-sm">{reasoningContent}</span>
							</div>
							{canScrollUp && (
								<div className="absolute top-0 left-0 right-0 h-6 pointer-events-none bg-gradient-to-b from-background to-transparent" />
							)}
							{canScrollDown && (
								<div className="absolute bottom-0 left-0 right-0 h-6 pointer-events-none bg-gradient-to-t from-background to-transparent" />
							)}
						</div>
					</div>
				)}
			</div>
		)
	},
)

ThinkingRow.displayName = "ThinkingRow"
