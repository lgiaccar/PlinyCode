import type { ClineMessage } from "@shared/ExtensionMessage"
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp } from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Virtuoso } from "react-virtuoso"
import ChatRow from "@/components/chat/ChatRow"
import { StickyUserMessage } from "@/components/chat/task-header/StickyUserMessage"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { useThinkingLoaderRow } from "../../hooks/useThinkingLoaderRow"
import type { ChatState, MessageHandlers, ScrollBehavior } from "../../types/chatTypes"
import { isActivityGroup } from "../../utils/activityGroups"
import { isPendingResponseUnconfirmed } from "../../utils/pendingResponse"
import { createMessageRenderer } from "../messages/MessageRenderer"

// Sentinel ts for the synthetic "Thinking..." placeholder row. Not a real message; ignored when
// deriving scroll triggers from the tail of the rendered list.
const WAITING_ROW_TS = Number.MIN_SAFE_INTEGER

// Synthetic placeholder rendered while waiting for the model with no visible rows streaming.
const WAITING_ROW: ClineMessage = {
	ts: WAITING_ROW_TS,
	type: "say",
	say: "reasoning",
	partial: true,
	text: "",
}

interface MessagesAreaProps {
	task: ClineMessage
	groupedMessages: (ClineMessage | ClineMessage[])[]
	modifiedMessages: ClineMessage[]
	scrollBehavior: ScrollBehavior
	chatState: ChatState
	messageHandlers: MessageHandlers
}

/**
 * The scrollable messages area with virtualized list
 * Handles rendering of chat rows and browser sessions
 */
export const MessagesArea: React.FC<MessagesAreaProps> = ({
	task,
	groupedMessages,
	modifiedMessages,
	scrollBehavior,
	chatState,
	messageHandlers,
}) => {
	const { clineMessages, turnState } = useExtensionState()
	const lastRawMessage = useMemo(() => clineMessages.at(-1), [clineMessages])

	const {
		virtuosoRef,
		scrollContainerRef,
		toggleRowExpansion,
		handleRowHeightChange,
		setIsAtBottom,
		disableAutoScrollRef,
		isManualScrollPaused,
		handleRangeChanged,
		scrolledPastUserMessage,
		scrollToMessage,
		scrollToBottomSmooth,
		scrollToBottomAuto,
		scrollToTopSmooth,
		handleLastRowContentChange,
		goToPreviousUserMessage,
		goToNextUserMessage,
		userMessageIndices,
		topVisibleIndex = 0,
	} = scrollBehavior

	// Find the index of the scrolled past user message for scrolling
	const scrolledPastUserMessageIndex = useMemo(() => {
		if (!scrolledPastUserMessage) {
			return -1
		}
		return clineMessages.findIndex((msg) => msg.ts === scrolledPastUserMessage.ts)
	}, [clineMessages, scrolledPastUserMessage])

	// Handler to scroll to the scrolled past user message
	const handleScrollToUserMessage = useCallback(() => {
		if (scrollToMessage && scrolledPastUserMessageIndex >= 0) {
			scrollToMessage(scrolledPastUserMessageIndex)
		}
	}, [scrollToMessage, scrolledPastUserMessageIndex])

	const { expandedRows, inputValue, setActiveQuote } = chatState
	const [expandedActivityGroups, setExpandedActivityGroups] = useState<Record<string, boolean>>({})
	const activityExpansion = useMemo(
		() => ({
			isExpanded: (groupTs: number) => expandedActivityGroups[`${task.ts}:${groupTs}`] ?? false,
			onToggle: (groupTs: number) => {
				disableAutoScrollRef.current = true
				const key = `${task.ts}:${groupTs}`
				setExpandedActivityGroups((current) => ({ ...current, [key]: !current[key] }))
			},
		}),
		[expandedActivityGroups, task.ts, disableAutoScrollRef],
	)
	const lastVisibleRow = useMemo(() => groupedMessages.at(-1), [groupedMessages])

	const lastVisibleMessage = useMemo(() => {
		const lastRow = lastVisibleRow
		if (!lastRow) {
			return undefined
		}
		return Array.isArray(lastRow) ? lastRow.at(-1) : lastRow
	}, [lastVisibleRow])
	// A turn (new task or follow-up) was just started from this webview but the backend's
	// streaming TurnState has not round-tripped yet, so the replica's turnState is stale
	// (idle/completed/awaiting_*). Let the loader show optimistically so "Thinking..." renders
	// the moment the send happens instead of popping in after the state post.
	const forcePendingResponseLoader = isPendingResponseUnconfirmed(chatState.pendingResponse, turnState, clineMessages.length)

	// Keep loader in the message flow (not footer). Show/hide logic (waiting heuristic,
	// waiting -> reasoning handoff guard, and anti-flash debounce on turn end) lives in the hook.
	const showThinkingLoaderRow = useThinkingLoaderRow({
		turnState,
		lastRawMessage,
		groupedMessages,
		lastVisibleRow,
		lastVisibleMessage,
		modifiedMessages,
		forceShow: forcePendingResponseLoader,
	})

	// While the list has no visible rows yet (new task just submitted), the loader is rendered as
	// a plain element instead of a Virtuoso item: a cold-mounting virtualized list takes several
	// frames to measure and paint its first item, which visibly delays the "Thinking..." shimmer
	// right when the chat view appears. Once any real row exists the list is warm and the loader
	// goes back to being an in-list row (unchanged behavior).
	const showEmptyListLoader = showThinkingLoaderRow && groupedMessages.length === 0

	const displayedGroupedMessages = useMemo<(ClineMessage | ClineMessage[])[]>(() => {
		if (!showThinkingLoaderRow || showEmptyListLoader) {
			return groupedMessages
		}
		// The trailing activity disclosure already supplies the compact working status.
		if (lastVisibleRow && isActivityGroup(lastVisibleRow)) {
			return groupedMessages
		}
		return [...groupedMessages, WAITING_ROW]
	}, [groupedMessages, showThinkingLoaderRow, showEmptyListLoader, lastVisibleRow])

	// useScrollBehavior auto-scrolls when groupedMessages.length changes, but rows can change here
	// without that: the waiting row is turnState-driven (e.g. plan -> act auto-continue adds no
	// message), new tool messages merge into the trailing tool group at constant length, and the
	// waiting row gets swapped for a real reasoning row. Pin to bottom for those too, keyed on the
	// rendered list's length and the tail message's ts (stable across partial updates, so this
	// doesn't fire while a message streams; row growth is handled by ChatRow's height observer).
	const lastTailTs = useMemo(() => {
		for (let i = displayedGroupedMessages.length - 1; i >= 0; i--) {
			const row = displayedGroupedMessages[i]
			const message = Array.isArray(row) ? row.at(-1) : row
			if (message && message.ts !== WAITING_ROW_TS) {
				return message.ts
			}
		}
		return undefined
	}, [displayedGroupedMessages])

	useEffect(() => {
		if (disableAutoScrollRef.current || isManualScrollPaused()) {
			return
		}
		scrollToBottomSmooth()
		// Settle with an instant scroll so late layout shifts can't leave us short of the bottom.
		// No cleanup: a quick follow-up change would cancel the settle scroll.
		setTimeout(() => {
			if (!disableAutoScrollRef.current && !isManualScrollPaused()) {
				scrollToBottomAuto()
			}
		}, 50)
	}, [
		displayedGroupedMessages.length,
		lastTailTs,
		scrollToBottomSmooth,
		scrollToBottomAuto,
		disableAutoScrollRef,
		isManualScrollPaused,
	])

	// Re-engage auto scroll when a new turn starts streaming. In the old extension every turn start
	// came from a webview action (send, approve, resume) whose handler reset disableAutoScrollRef;
	// a turnState-driven start like plan -> act auto-continue has no webview-side action, so reset
	// it here to keep the old "new turn pins to bottom" behavior.
	const prevTurnPhaseRef = useRef(turnState?.phase)
	useEffect(() => {
		const prevPhase = prevTurnPhaseRef.current
		prevTurnPhaseRef.current = turnState?.phase
		if (turnState?.phase === "streaming" && prevPhase !== "streaming" && !isManualScrollPaused()) {
			disableAutoScrollRef.current = false
			scrollToBottomSmooth()
		}
	}, [turnState?.phase, scrollToBottomSmooth, disableAutoScrollRef, isManualScrollPaused])

	const itemContent = useMemo(
		() =>
			createMessageRenderer(
				displayedGroupedMessages,
				modifiedMessages,
				expandedRows,
				toggleRowExpansion,
				handleRowHeightChange,
				handleLastRowContentChange,
				setActiveQuote,
				inputValue,
				messageHandlers,
				false,
				activityExpansion,
			),
		[
			displayedGroupedMessages,
			modifiedMessages,
			expandedRows,
			toggleRowExpansion,
			handleRowHeightChange,
			handleLastRowContentChange,
			setActiveQuote,
			inputValue,
			messageHandlers,
			activityExpansion,
		],
	)

	// Keep footer as a simple spacer. Thinking loading is rendered as an in-list row.
	const virtuosoComponents = useMemo(
		() => ({
			Footer: () => <div className="min-h-1" />,
		}),
		[],
	)

	// User-input markers on the scrollbar edge. Ticks are positioned by index within
	// displayedGroupedMessages (index / (total - 1) of the track height), not by pixel
	// offset: real offsets for unrendered/virtualized rows aren't known, but index-proportional
	// placement is stable and cheap to compute for arbitrarily long conversations.
	const showInputMarkers = userMessageIndices.length >= 3
	const lastRowIndex = displayedGroupedMessages.length - 1

	const inputMarkers = useMemo(() => {
		if (!showInputMarkers || lastRowIndex <= 0) {
			return []
		}
		return userMessageIndices.map((index) => {
			const row = displayedGroupedMessages[index]
			const message = Array.isArray(row) ? row[0] : row
			const preview = (message?.text ?? "").trim().replace(/\s+/g, " ").slice(0, 60)
			return {
				index,
				preview,
				position: index / lastRowIndex,
			}
		})
	}, [showInputMarkers, lastRowIndex, userMessageIndices, displayedGroupedMessages])

	// Keyed on the row at the top of the viewport. Virtuoso's rangeChanged startIndex includes the
	// 3000px overscan above the viewport, so it highlighted a prompt well above the one in view.
	const activeMarkerIndex = useMemo(() => {
		let active = -1
		for (const marker of inputMarkers) {
			if (marker.index <= topVisibleIndex) {
				active = marker.index
			}
		}
		return active
	}, [inputMarkers, topVisibleIndex])

	const prefersReducedMotion = useMemo(
		() =>
			typeof window !== "undefined" &&
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches,
		[],
	)

	const handleMarkerClick = useCallback(
		(index: number) => {
			disableAutoScrollRef.current = true
			virtuosoRef.current?.scrollToIndex({
				index,
				align: "start",
				behavior: prefersReducedMotion ? "auto" : "smooth",
			})
		},
		[disableAutoScrollRef, virtuosoRef, prefersReducedMotion],
	)

	return (
		<div className="overflow-hidden flex flex-col flex-1 min-h-0 relative">
			{/* Sticky User Message - positioned absolutely to avoid layout shifts */}
			<div
				className={cn(
					"absolute top-0 left-0 right-0 z-10 pl-[15px] pr-[14px] bg-background",
					scrolledPastUserMessage && "pb-2",
				)}>
				<StickyUserMessage
					isVisible={!!scrolledPastUserMessage}
					lastUserMessage={scrolledPastUserMessage}
					onScrollToMessage={handleScrollToUserMessage}
				/>
			</div>

			<div className="flex-1 min-h-0 flex relative" ref={scrollContainerRef}>
				{/* Empty-list fast path: paint the loader immediately without waiting for the
				    virtualized list's initial measure/render cycle. Mirrors the in-list row's
				    markup (MessageRenderer wrapper + ChatRow) so the swap to a real row later
				    causes no visual jump. Virtuoso stays mounted (empty) underneath, so it is
				    already warm when the first real row arrives. */}
				{showEmptyListLoader && (
					<div className="absolute inset-0 overflow-hidden">
						<ChatRow
							inputValue={inputValue}
							isExpanded={false}
							isLast={true}
							lastModifiedMessage={modifiedMessages.at(-1)}
							message={WAITING_ROW}
							onCancelCommand={() => messageHandlers.executeButtonAction("cancel")}
							onHeightChange={handleRowHeightChange}
							onLastRowContentChange={handleLastRowContentChange}
							onSetQuote={setActiveQuote}
							onToggleExpand={toggleRowExpansion}
							sendMessageFromChatRow={messageHandlers.handleSendMessage}
						/>
					</div>
				)}
				<Virtuoso
					atBottomStateChange={(isAtBottom) => {
						setIsAtBottom(isAtBottom)
						if (isAtBottom && !isManualScrollPaused()) {
							disableAutoScrollRef.current = false
						}
					}}
					atBottomThreshold={10} // trick to make sure virtuoso re-renders when task changes, and we use initialTopMostItemIndex to start at the bottom
					className="scrollable grow overflow-y-scroll"
					components={virtuosoComponents}
					data={displayedGroupedMessages}
					// increasing top by 3_000 to prevent jumping around when user collapses a row
					increaseViewportBy={{
						top: 3_000,
						bottom: Number.MAX_SAFE_INTEGER,
					}} // hack to make sure the last message is always rendered to get truly perfect scroll to bottom animation when new messages are added (Number.MAX_SAFE_INTEGER is safe for arithmetic operations, which is all virtuoso uses this value for in src/sizeRangeSystem.ts)
					initialTopMostItemIndex={displayedGroupedMessages.length - 1} // messages is the raw format returned by extension, modifiedMessages is the manipulated structure that combines certain messages of related type, and visibleMessages is the filtered structure that removes messages that should not be rendered
					itemContent={itemContent}
					key={task.ts}
					rangeChanged={handleRangeChanged}
					ref={virtuosoRef} // anything lower causes issues with followOutput
					style={{
						overflowAnchor: "none", // prevent scroll jump when content expands
					}}
				/>
				{/* User-input markers on the scrollbar edge. Positioned index-proportionally
				    (see inputMarkers above); pointer events are limited to the ticks so the
				    overlay never intercepts clicks/drags meant for the scrollbar or content. */}
				{showInputMarkers && (
					<div className="absolute top-0 right-0 bottom-0 w-2.5 z-20 pointer-events-none">
						{inputMarkers.map((marker) => (
							<button
								className={cn(
									"absolute right-0 w-2.5 h-1 -translate-y-1/2 rounded-[1px] pointer-events-auto cursor-pointer",
									"opacity-75 hover:opacity-100 transition-opacity",
									marker.index === activeMarkerIndex && "opacity-100",
								)}
								key={marker.index}
								onClick={() => handleMarkerClick(marker.index)}
								style={{
									top: `${marker.position * 100}%`,
									// The accent colour stands out against the translucent scrollbar slider.
									backgroundColor: "var(--vscode-focusBorder, var(--vscode-scrollbarSlider-activeBackground))",
								}}
								title={marker.preview}
								type="button"
							/>
						))}
					</div>
				)}
			</div>
			{/* Reserve space outside the scroller so navigation stays visible in either sidebar,
			    including narrow panels, short conversations and while the composer grows. */}
			<div
				aria-label="Conversation navigation"
				className="shrink-0 flex justify-end gap-1 px-3 py-1 bg-background border-t border-(--vscode-panel-border)"
				role="group">
				<NavButton onClick={scrollToTopSmooth} title="Scroll to top">
					<ArrowUp size={16} />
				</NavButton>
				<NavButton onClick={goToPreviousUserMessage} title="Previous user message">
					<ChevronUp size={16} />
				</NavButton>
				<NavButton onClick={goToNextUserMessage} title="Next user message">
					<ChevronDown size={16} />
				</NavButton>
				<NavButton onClick={scrollToBottomSmooth} title="Scroll to bottom">
					<ArrowDown size={16} />
				</NavButton>
			</div>
		</div>
	)
}

const NavButton: React.FC<{ onClick: () => void; title: string; children: React.ReactNode }> = ({ onClick, title, children }) => (
	<button
		aria-label={title}
		className={cn(
			"flex shrink-0 items-center justify-center w-7 h-7 rounded",
			"cursor-pointer select-none hover:bg-(--vscode-toolbar-hoverBackground)",
			"focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)",
		)}
		onClick={onClick}
		style={{
			color: "var(--vscode-foreground)",
		}}
		title={title}
		type="button">
		{children}
	</button>
)
