import { ClineMessage } from "@shared/ExtensionMessage"
import debounce from "debounce"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useEvent } from "react-use"
import { ListRange, VirtuosoHandle } from "react-virtuoso"
import { ScrollBehavior } from "../types/chatTypes"

// Height of the sticky user message header (padding + content)
const STICKY_HEADER_HEIGHT = 32

/**
 * Custom hook for managing scroll behavior
 * Handles auto-scrolling, manual scrolling, and scroll-to-message functionality
 */
export function useScrollBehavior(
	messages: ClineMessage[],
	visibleMessages: ClineMessage[],
	groupedMessages: (ClineMessage | ClineMessage[])[],
	expandedRows: Record<number, boolean>,
	setExpandedRows: React.Dispatch<React.SetStateAction<Record<number, boolean>>>,
): ScrollBehavior & {
	isAtBottom: boolean
	setIsAtBottom: React.Dispatch<React.SetStateAction<boolean>>
	isAtTop: boolean
	setIsAtTop: React.Dispatch<React.SetStateAction<boolean>>
	pendingScrollToMessage: number | null
	setPendingScrollToMessage: React.Dispatch<React.SetStateAction<number | null>>
	scrolledPastUserMessage: ClineMessage | null
	topVisibleIndex: number
	handleRangeChanged: (range: ListRange) => void
} {
	// Refs
	const virtuosoRef = useRef<VirtuosoHandle>(null)
	const scrollContainerRef = useRef<HTMLDivElement>(null)
	const disableAutoScrollRef = useRef(false)
	const layoutSettleScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const visibleRangeRef = useRef<ListRange>({ startIndex: 0, endIndex: 0 })

	// State
	const [isAtBottom, setIsAtBottom] = useState(false)
	const [isAtTop, setIsAtTop] = useState(false)
	const [pendingScrollToMessage, setPendingScrollToMessage] = useState<number | null>(null)
	const [scrolledPastUserMessage, setScrolledPastUserMessage] = useState<ClineMessage | null>(null)
	const [topVisibleIndex, setTopVisibleIndex] = useState(0)

	// Find all user feedback messages
	const userFeedbackMessages = useMemo(() => {
		return visibleMessages.filter((msg) => msg.say === "user_feedback")
	}, [visibleMessages])

	// Build indices of user messages (task + user_feedback) inside groupedMessages for navigation
	const userMessageIndices = useMemo(() => {
		const indices: number[] = []
		for (let i = 0; i < groupedMessages.length; i++) {
			const item = groupedMessages[i]
			if (!Array.isArray(item) && (item.say === "user_feedback" || item.say === "task")) {
				indices.push(i)
			}
		}
		return indices
	}, [groupedMessages])

	const getScroller = useCallback(
		() => scrollContainerRef.current?.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]') ?? null,
		[],
	)

	// The row at the top of the viewport, read from the DOM. Virtuoso's rangeChanged can't be used
	// for this: it reports the rendered range, which includes the 3000px increaseViewportBy band
	// above the viewport, so its startIndex sits well above what the user is looking at.
	// The reading line sits just below the sticky prompt header, so a prompt that navigation
	// aligned under the header counts as the top row.
	const getTopVisibleRow = useCallback((): { index: number; cutOff: boolean } | null => {
		const scroller = getScroller()
		if (!scroller) {
			return null
		}
		const scrollerTop = scroller.getBoundingClientRect().top
		const readingLine = scrollerTop + STICKY_HEADER_HEIGHT + 2
		for (const row of scroller.querySelectorAll<HTMLElement>("[data-index]")) {
			const rect = row.getBoundingClientRect()
			if (rect.height > 0 && rect.bottom > readingLine) {
				const index = Number(row.dataset.index)
				if (Number.isNaN(index)) {
					continue
				}
				return { index, cutOff: rect.top < scrollerTop - 4 }
			}
		}
		return null
	}, [getScroller])

	// The last prompt navigated to, so repeated clicks during a smooth scroll step from the
	// target rather than from wherever the animation happens to be.
	const navTargetRef = useRef<{ index: number; at: number } | null>(null)
	const NAV_TARGET_TTL_MS = 800

	const scrollToRow = useCallback(
		(index: number) => {
			disableAutoScrollRef.current = true
			navTargetRef.current = { index, at: Date.now() }
			// Smooth-scrolling to a row that isn't rendered goes through estimated heights and
			// Virtuoso corrects it in several animations, which is slow and can land off-target.
			const rendered = !!getScroller()?.querySelector(`[data-index="${index}"]`)
			const isFirstPrompt = userMessageIndices[0] === index
			virtuosoRef.current?.scrollToIndex({
				index,
				align: "start",
				behavior: rendered ? "smooth" : "auto",
				offset: isFirstPrompt ? 0 : -STICKY_HEADER_HEIGHT,
			})
		},
		[getScroller, userMessageIndices],
	)

	const getNavigationAnchor = useCallback((): { index: number; cutOff: boolean } => {
		const target = navTargetRef.current
		if (target && Date.now() - target.at < NAV_TARGET_TTL_MS) {
			return { index: target.index, cutOff: false }
		}
		return getTopVisibleRow() ?? { index: visibleRangeRef.current.startIndex, cutOff: false }
	}, [getTopVisibleRow])

	// Smooth scroll to bottom with debounce
	const scrollToBottomSmooth = useMemo(
		() =>
			debounce(
				() => {
					virtuosoRef.current?.scrollTo({
						top: Number.MAX_SAFE_INTEGER,
						behavior: "smooth",
					})
				},
				10,
				{ immediate: true },
			),
		[],
	)

	// Scroll to the very top of the conversation. Disables auto-scroll so streaming
	// output doesn't yank the view back down.
	const scrollToTopSmooth = useCallback(() => {
		disableAutoScrollRef.current = true
		navTargetRef.current = null
		const rendered = !!getScroller()?.querySelector('[data-index="0"]')
		virtuosoRef.current?.scrollToIndex({
			index: 0,
			align: "start",
			behavior: rendered ? "smooth" : "auto",
		})
	}, [getScroller])

	// Navigate to the previous user message (going up in the conversation). A prompt cut off at
	// the top is brought fully into view first; above the first prompt it goes to the top.
	const goToPreviousUserMessage = useCallback(() => {
		const anchor = getNavigationAnchor()
		if (anchor.cutOff && userMessageIndices.includes(anchor.index)) {
			scrollToRow(anchor.index)
			return
		}
		for (let i = userMessageIndices.length - 1; i >= 0; i--) {
			if (userMessageIndices[i] < anchor.index) {
				scrollToRow(userMessageIndices[i])
				return
			}
		}
		scrollToTopSmooth()
	}, [getNavigationAnchor, userMessageIndices, scrollToRow, scrollToTopSmooth])

	// Navigate to the next user message (going down in the conversation); past the last prompt it
	// goes to the bottom, which re-engages auto-scroll.
	const goToNextUserMessage = useCallback(() => {
		const anchor = getNavigationAnchor()
		for (const idx of userMessageIndices) {
			if (idx > anchor.index) {
				scrollToRow(idx)
				return
			}
		}
		navTargetRef.current = null
		scrollToBottomSmooth()
	}, [getNavigationAnchor, userMessageIndices, scrollToRow, scrollToBottomSmooth])

	// Track scroll position to detect which user message has been scrolled past
	// Shows the most recent user message that's above the current viewport
	const checkScrolledPastUserMessage = useCallback(() => {
		const scrollContainer = scrollContainerRef.current
		if (!scrollContainer || userFeedbackMessages.length === 0) {
			setScrolledPastUserMessage(null)
			return
		}

		const containerRect = scrollContainer.getBoundingClientRect()

		// Find the most recent (last in order) user message that's been scrolled past
		// We iterate from the end to find the latest one that's above the viewport
		let mostRecentScrolledPast: ClineMessage | null = null

		// Track if we've found any visible message element in the DOM
		// This helps us determine if missing elements are above or below viewport
		let foundAnyVisibleElement = false

		for (let i = userFeedbackMessages.length - 1; i >= 0; i--) {
			const msg = userFeedbackMessages[i]
			const messageElement = scrollContainer.querySelector(`[data-message-ts="${msg.ts}"]`) as HTMLElement

			if (messageElement) {
				foundAnyVisibleElement = true
				const messageRect = messageElement.getBoundingClientRect()
				// Message is scrolled past if its bottom edge is above (or near) the container's top
				// Add a small threshold so the pin appears slightly before message fully scrolls out
				const threshold = 10
				if (messageRect.bottom < containerRect.top + threshold) {
					mostRecentScrolledPast = msg
					break // Found the most recent one that's scrolled past
				}
			} else {
				// Element not in DOM - it's virtualized out
				// Only consider it scrolled past if we've already found a visible element after it
				// (meaning this missing element is above the viewport, not below)
				if (foundAnyVisibleElement) {
					mostRecentScrolledPast = msg
					break
				}
				// If we haven't found any visible elements yet, this message might be
				// below the viewport, so continue looking for visible elements
			}
		}

		setScrolledPastUserMessage(mostRecentScrolledPast)
	}, [userFeedbackMessages])

	// Use scroll event listener - attach to the scrollable element inside the container
	useEffect(() => {
		const scrollContainer = scrollContainerRef.current
		if (!scrollContainer) {
			return
		}

		// The scrollable element is the Virtuoso scroller or a child with overflow
		const findScrollableElement = () => {
			// Try finding the Virtuoso scroller
			const virtuosoScroller = scrollContainer.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement
			if (virtuosoScroller) {
				return virtuosoScroller
			}
			// Fallback to the first child with scrollable class
			const scrollable = scrollContainer.querySelector(".scrollable") as HTMLElement
			return scrollable || scrollContainer
		}

		const scrollableElement = findScrollableElement()

		const syncAtTop = () => {
			// Virtuoso's atTopStateChange is unreliable here because increaseViewportBy.top
			// is 3000px, which keeps reporting "at top" even when the user has scrolled down.
			setIsAtTop(scrollableElement.scrollTop <= 16)
		}

		const sync = () => {
			syncAtTop()
			checkScrolledPastUserMessage()
			setTopVisibleIndex(getTopVisibleRow()?.index ?? 0)
		}

		// One layout read per frame: the checks call getBoundingClientRect on several rows, and
		// running them on every scroll event made smooth navigation janky.
		let frame: number | null = null
		const handleScroll = () => {
			if (frame !== null) {
				return
			}
			frame = requestAnimationFrame(() => {
				frame = null
				sync()
			})
		}

		scrollableElement.addEventListener("scroll", handleScroll, { passive: true })

		sync()

		return () => {
			if (frame !== null) {
				cancelAnimationFrame(frame)
			}
			scrollableElement.removeEventListener("scroll", handleScroll)
		}
	}, [checkScrolledPastUserMessage, getTopVisibleRow])

	// Handler for when visible range changes in Virtuoso
	const handleRangeChanged = useCallback((range: ListRange) => {
		visibleRangeRef.current = range
	}, [])

	const scrollToBottomAuto = useCallback(() => {
		virtuosoRef.current?.scrollTo({
			top: Number.MAX_SAFE_INTEGER,
			behavior: "auto", // instant causes crash
		})
	}, [])

	const scrollToMessage = useCallback(
		(messageIndex: number) => {
			setPendingScrollToMessage(messageIndex)

			const targetMessage = messages[messageIndex]
			if (!targetMessage) {
				setPendingScrollToMessage(null)
				return
			}

			const visibleIndex = visibleMessages.findIndex((msg) => msg.ts === targetMessage.ts)
			if (visibleIndex === -1) {
				setPendingScrollToMessage(null)
				return
			}

			let groupIndex = -1

			for (let i = 0; i < groupedMessages.length; i++) {
				const group = groupedMessages[i]
				if (Array.isArray(group)) {
					const messageInGroup = group.some((msg) => msg.ts === targetMessage.ts)
					if (messageInGroup) {
						groupIndex = i
						break
					}
				} else {
					if (group.ts === targetMessage.ts) {
						groupIndex = i
						break
					}
				}
			}

			if (groupIndex !== -1) {
				setPendingScrollToMessage(null)
				disableAutoScrollRef.current = true

				// Check if this is the first user feedback message (no sticky header would show when scrolling to it)
				const isFirstUserMessage =
					groupIndex === 0 || !visibleMessages.slice(0, visibleIndex).some((msg) => msg.say === "user_feedback")

				const stickyHeaderOffset = isFirstUserMessage ? 0 : STICKY_HEADER_HEIGHT

				// Use scrollToIndex with offset - Virtuoso handles this more reliably than manual scrollTo
				requestAnimationFrame(() => {
					virtuosoRef.current?.scrollToIndex({
						index: groupIndex,
						align: "start",
						behavior: "smooth",
						offset: -stickyHeaderOffset,
					})
				})
			}
		},
		[messages, visibleMessages, groupedMessages],
	)

	// scroll when user toggles certain rows
	const toggleRowExpansion = useCallback(
		(ts: number, options?: { preserveAutoScroll?: boolean }) => {
			const isCollapsing = expandedRows[ts] ?? false
			const lastGroup = groupedMessages.at(-1)
			const isLast = Array.isArray(lastGroup) ? lastGroup[0].ts === ts : lastGroup?.ts === ts
			const secondToLastGroup = groupedMessages.at(-2)
			const isSecondToLast = Array.isArray(secondToLastGroup)
				? secondToLastGroup[0].ts === ts
				: secondToLastGroup?.ts === ts

			const isLastCollapsedApiReq =
				isLast &&
				!Array.isArray(lastGroup) && // Make sure it's not a tool group
				lastGroup?.say === "api_req_started" &&
				!expandedRows[lastGroup.ts]

			setExpandedRows((prev) => ({
				...prev,
				[ts]: !prev[ts],
			}))

			// Disable auto-scroll when the user expands a row. Programmatic expansions
			// for active command output should keep bottom pinning engaged.
			if (!isCollapsing && !options?.preserveAutoScroll) {
				disableAutoScrollRef.current = true
			}
			// Only scroll on collapse, never on expand - expanding should stay in place
			if (isCollapsing && isAtBottom) {
				const timer = setTimeout(() => {
					scrollToBottomAuto()
				}, 0)
				return () => clearTimeout(timer)
			}
			if (isCollapsing && (isLast || isSecondToLast)) {
				if (isSecondToLast && !isLastCollapsedApiReq) {
					return
				}
				const timer = setTimeout(() => {
					scrollToBottomAuto()
				}, 0)
				return () => clearTimeout(timer)
			}
			// When expanding, don't scroll - let the element expand in place
		},
		[groupedMessages, expandedRows, scrollToBottomAuto, isAtBottom],
	)

	const clearLayoutSettleScrollTimers = useCallback(() => {
		if (layoutSettleScrollTimerRef.current !== null) {
			clearTimeout(layoutSettleScrollTimerRef.current)
			layoutSettleScrollTimerRef.current = null
		}
	}, [])

	const keepPinnedToBottomAfterLayout = useCallback(() => {
		if (disableAutoScrollRef.current) {
			return
		}

		if (layoutSettleScrollTimerRef.current !== null) {
			clearTimeout(layoutSettleScrollTimerRef.current)
		}
		layoutSettleScrollTimerRef.current = setTimeout(() => {
			if (!disableAutoScrollRef.current) {
				scrollToBottomSmooth()
			}
			layoutSettleScrollTimerRef.current = null
		}, 500)
	}, [scrollToBottomSmooth])

	const handleRowHeightChange = useCallback(
		(_isTaller: boolean) => {
			keepPinnedToBottomAfterLayout()
		},
		[keepPinnedToBottomAfterLayout],
	)

	const handleLastRowContentChange = useCallback(() => {
		keepPinnedToBottomAfterLayout()
	}, [keepPinnedToBottomAfterLayout])

	useEffect(() => clearLayoutSettleScrollTimers, [clearLayoutSettleScrollTimers])

	useEffect(() => {
		if (!disableAutoScrollRef.current) {
			scrollToBottomSmooth()
			setTimeout(() => {
				if (!disableAutoScrollRef.current) {
					scrollToBottomAuto()
				}
			}, 40)
			setTimeout(() => {
				if (!disableAutoScrollRef.current) {
					scrollToBottomAuto()
				}
			}, 70)
			// return () => clearTimeout(timer) // dont cleanup since if visibleMessages.length changes it cancels.
		}
	}, [groupedMessages.length, scrollToBottomSmooth, scrollToBottomAuto])

	useEffect(() => {
		if (pendingScrollToMessage !== null) {
			scrollToMessage(pendingScrollToMessage)
		}
	}, [pendingScrollToMessage, groupedMessages, scrollToMessage])

	const handleWheel = useCallback((event: Event) => {
		const wheelEvent = event as WheelEvent
		if (wheelEvent.deltaY && wheelEvent.deltaY < 0) {
			if (scrollContainerRef.current?.contains(wheelEvent.target as Node)) {
				// user scrolled up
				disableAutoScrollRef.current = true
			}
		}
		// Manual scrolling moves away from the last navigation target.
		if (wheelEvent.deltaY && scrollContainerRef.current?.contains(wheelEvent.target as Node)) {
			navTargetRef.current = null
		}
	}, [])
	useEvent("wheel", handleWheel, window, { passive: true }) // passive improves scrolling performance

	return {
		virtuosoRef,
		scrollContainerRef,
		disableAutoScrollRef,
		scrollToBottomSmooth,
		scrollToBottomAuto,
		scrollToTopSmooth,
		scrollToMessage,
		toggleRowExpansion,
		handleRowHeightChange,
		handleLastRowContentChange,
		isAtBottom,
		setIsAtBottom,
		isAtTop,
		setIsAtTop,
		pendingScrollToMessage,
		setPendingScrollToMessage,
		scrolledPastUserMessage,
		topVisibleIndex,
		handleRangeChanged,
		goToPreviousUserMessage,
		goToNextUserMessage,
		userMessageIndices,
	}
}
