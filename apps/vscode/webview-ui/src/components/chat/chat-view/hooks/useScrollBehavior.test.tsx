import type { ClineMessage } from "@shared/ExtensionMessage"
import { act, fireEvent, renderHook } from "@testing-library/react"
import type { MutableRefObject } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useScrollBehavior } from "./useScrollBehavior"

const commandMessage = {
	ts: 1,
	type: "ask",
	ask: "command",
	text: "echo hi",
}

describe("useScrollBehavior", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("scrolls to bottom after command output layout has been quiet for 500ms", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
		const scrollTo = vi.fn()
		act(() => {
			vi.runOnlyPendingTimers()
		})
		;(result.current.virtuosoRef as MutableRefObject<{ scrollTo: typeof scrollTo } | null>).current = { scrollTo }

		act(() => {
			result.current.handleLastRowContentChange()
		})

		expect(scrollTo).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(499)
		})
		expect(scrollTo).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(scrollTo).toHaveBeenCalledWith({
			top: Number.MAX_SAFE_INTEGER,
			behavior: "smooth",
		})
	})

	it("resets the 500ms wait when another command output change arrives", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
		const scrollTo = vi.fn()
		act(() => {
			vi.runOnlyPendingTimers()
		})
		;(result.current.virtuosoRef as MutableRefObject<{ scrollTo: typeof scrollTo } | null>).current = { scrollTo }

		act(() => {
			result.current.handleLastRowContentChange()
			scrollTo.mockClear()
			vi.advanceTimersByTime(400)
			result.current.handleLastRowContentChange()
			scrollTo.mockClear()
			vi.advanceTimersByTime(499)
		})
		expect(scrollTo).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(scrollTo).toHaveBeenCalledWith({
			top: Number.MAX_SAFE_INTEGER,
			behavior: "smooth",
		})
	})

	it("does not re-pin command output changes after auto-scroll is disabled", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
		const scrollTo = vi.fn()
		;(result.current.virtuosoRef as MutableRefObject<{ scrollTo: typeof scrollTo } | null>).current = { scrollTo }

		act(() => {
			result.current.disableAutoScrollRef.current = true
			result.current.handleLastRowContentChange()
			vi.runAllTimers()
		})

		expect(scrollTo).not.toHaveBeenCalled()
	})

	it("pauses automatic scrolling for one minute after a manual wheel movement", () => {
		const { result, rerender } = renderHook(({ rows }) => useScrollBehavior([], [], rows as ClineMessage[], {}, vi.fn()), {
			initialProps: { rows: [] as ClineMessage[] },
		})
		const container = document.createElement("div")
		document.body.appendChild(container)
		;(result.current.scrollContainerRef as MutableRefObject<HTMLDivElement | null>).current = container
		const scrollTo = vi.fn()
		;(result.current.virtuosoRef as MutableRefObject<any>).current = { scrollTo }

		act(() => fireEvent.wheel(container, { deltaY: -20 }))
		expect(result.current.isManualScrollPaused()).toBe(true)
		// A send or a new turn may reset this legacy flag; the manual pause must still win.
		result.current.disableAutoScrollRef.current = false
		rerender({ rows: [commandMessage as ClineMessage] })
		expect(scrollTo).not.toHaveBeenCalled()

		act(() => vi.advanceTimersByTime(59_999))
		rerender({ rows: [commandMessage as ClineMessage, { ...commandMessage, ts: 2 } as ClineMessage] })
		expect(scrollTo).not.toHaveBeenCalled()
		act(() => vi.advanceTimersByTime(1))
		expect(result.current.isManualScrollPaused()).toBe(false)
		rerender({
			rows: [
				commandMessage as ClineMessage,
				{ ...commandMessage, ts: 2 } as ClineMessage,
				{ ...commandMessage, ts: 3 } as ClineMessage,
			],
		})
		expect(scrollTo).toHaveBeenCalled()
		container.remove()
	})

	it("pauses when the scrollbar is dragged and resumes when the user chooses the bottom", () => {
		const feedback = { ts: 3, type: "say", say: "user_feedback", text: "more" } as ClineMessage
		const { result, rerender } = renderHook(({ visible }) => useScrollBehavior([], visible, [], {}, vi.fn()), {
			initialProps: { visible: [] as ClineMessage[] },
		})
		const container = document.createElement("div")
		const scroller = document.createElement("div")
		scroller.setAttribute("data-virtuoso-scroller", "true")
		container.appendChild(scroller)
		;(result.current.scrollContainerRef as MutableRefObject<HTMLDivElement | null>).current = container
		;(result.current.virtuosoRef as MutableRefObject<any>).current = { scrollTo: vi.fn() }
		rerender({ visible: [feedback] })

		act(() => {
			fireEvent.pointerDown(scroller)
			fireEvent.scroll(scroller)
			fireEvent.pointerUp(window)
		})
		expect(result.current.isManualScrollPaused()).toBe(true)
		act(() => vi.advanceTimersByTime(11)) // let the initial bottom-scroll debounce finish
		act(() => result.current.scrollToBottomSmooth())
		expect(result.current.isManualScrollPaused()).toBe(false)
	})

	it("disables auto-scroll when a user expands a row", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [commandMessage as any], {}, vi.fn()))

		act(() => {
			result.current.toggleRowExpansion(commandMessage.ts)
		})

		expect(result.current.disableAutoScrollRef.current).toBe(true)
	})

	it("keeps auto-scroll enabled when command output expands programmatically", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [commandMessage as any], {}, vi.fn()))

		act(() => {
			result.current.toggleRowExpansion(commandMessage.ts, { preserveAutoScroll: true })
		})

		expect(result.current.disableAutoScrollRef.current).toBe(false)
	})

	describe("prompt navigation", () => {
		// Rows 0..5; prompts (task / user_feedback) at 0, 2 and 4. Each row is 100px tall.
		const groupedMessages = [
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "say", say: "text", text: "response" },
			{ ts: 3, type: "say", say: "user_feedback", text: "follow up" },
			{ ts: 4, type: "say", say: "text", text: "response" },
			{ ts: 5, type: "say", say: "user_feedback", text: "another" },
			{ ts: 6, type: "say", say: "text", text: "response" },
		]
		const ROW_HEIGHT = 100

		/**
		 * Builds the Virtuoso DOM the hook reads: a scroller whose top is at y=0 and one element per
		 * rendered row. `scrollTop` shifts the rows up, like a scrolled list.
		 */
		function mountList(
			result: { current: ReturnType<typeof useScrollBehavior> },
			scrollTop: number,
			rendered = [0, 1, 2, 3, 4, 5],
		) {
			const container = document.createElement("div")
			const scroller = document.createElement("div")
			scroller.setAttribute("data-virtuoso-scroller", "true")
			scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300 }) as DOMRect
			for (const index of rendered) {
				const row = document.createElement("div")
				row.setAttribute("data-index", String(index))
				const top = index * ROW_HEIGHT - scrollTop
				row.getBoundingClientRect = () => ({ top, bottom: top + ROW_HEIGHT, height: ROW_HEIGHT }) as DOMRect
				scroller.appendChild(row)
			}
			container.appendChild(scroller)
			;(result.current.scrollContainerRef as MutableRefObject<HTMLDivElement | null>).current = container
		}

		function setup() {
			const { result } = renderHook(() => useScrollBehavior([], [], groupedMessages as any, {}, vi.fn()))
			const scrollToIndex = vi.fn()
			const scrollTo = vi.fn()
			;(result.current.virtuosoRef as MutableRefObject<any>).current = { scrollToIndex, scrollTo }
			return { result, scrollToIndex, scrollTo }
		}

		it("skips agent answers and CI reports when navigating prompts", () => {
			const rows = [
				groupedMessages[0],
				{ ts: 2, type: "say", say: "user_feedback", text: "Approved", answersTool: true },
				groupedMessages[2],
				{ ts: 4, type: "say", say: "user_feedback", text: "[CI WATCHER] passed" },
				{ ts: 5, type: "say", say: "user_feedback", text: "side question", offTheRecord: true },
			]
			const { result } = renderHook(() => useScrollBehavior([], [], rows as ClineMessage[], {}, vi.fn()))
			expect(result.current.userMessageIndices).toEqual([0, 2, 4])
		})

		it("goes to the previous prompt above the viewport, aligned under the sticky header", () => {
			const { result, scrollToIndex } = setup()
			// Prompt 4 sits under the sticky header (row 3 ends at the header's bottom edge).
			mountList(result, 4 * ROW_HEIGHT - 32)

			act(() => result.current.goToPreviousUserMessage())

			expect(scrollToIndex).toHaveBeenCalledWith({ index: 2, align: "start", behavior: "smooth", offset: -32 })
			expect(result.current.disableAutoScrollRef.current).toBe(true)
		})

		it("reads the position from the viewport, not Virtuoso's overscanned range", () => {
			const { result, scrollToIndex } = setup()
			mountList(result, 3 * ROW_HEIGHT)
			// rangeChanged reports the rendered range, which starts far above the viewport.
			act(() => result.current.handleRangeChanged({ startIndex: 0, endIndex: 5 }))

			act(() => result.current.goToNextUserMessage())

			expect(scrollToIndex).toHaveBeenCalledWith({ index: 4, align: "start", behavior: "smooth", offset: -32 })
		})

		it("steps from the last target when clicked again during the scroll animation", () => {
			const { result, scrollToIndex } = setup()
			mountList(result, 5 * ROW_HEIGHT)

			act(() => result.current.goToPreviousUserMessage())
			act(() => result.current.goToPreviousUserMessage())
			act(() => result.current.goToPreviousUserMessage())

			expect(scrollToIndex.mock.calls.map(([arg]) => arg.index)).toEqual([4, 2, 0])
			// The first prompt has no sticky header above it.
			expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 0, align: "start", behavior: "smooth", offset: 0 })
		})

		it("restores auto-scroll and clears the previous target when going back to the bottom", () => {
			const { result, scrollToIndex, scrollTo } = setup()
			mountList(result, 5 * ROW_HEIGHT)
			act(() => vi.advanceTimersByTime(1000))
			act(() => result.current.goToPreviousUserMessage())
			expect(result.current.disableAutoScrollRef.current).toBe(true)

			act(() => result.current.scrollToBottomSmooth())
			expect(scrollTo).toHaveBeenCalledWith({ top: Number.MAX_SAFE_INTEGER, behavior: "smooth" })
			expect(result.current.disableAutoScrollRef.current).toBe(false)

			act(() => result.current.goToPreviousUserMessage())
			expect(scrollToIndex.mock.calls.map(([arg]) => arg.index)).toEqual([4, 4])
		})

		it("brings a prompt cut off at the top fully into view first", () => {
			const { result, scrollToIndex } = setup()
			mountList(result, 2 * ROW_HEIGHT + 50)

			act(() => result.current.goToPreviousUserMessage())

			expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 2 }))
		})

		it("jumps without animation to a prompt that isn't rendered", () => {
			const { result, scrollToIndex } = setup()
			mountList(result, 4 * ROW_HEIGHT - 32, [3, 4, 5])

			act(() => result.current.goToPreviousUserMessage())

			expect(scrollToIndex).toHaveBeenCalledWith({ index: 2, align: "start", behavior: "auto", offset: -32 })
		})

		it("goes to the top above the first prompt and to the bottom past the last", () => {
			const { result, scrollToIndex, scrollTo } = setup()
			mountList(result, 0)

			act(() => result.current.goToPreviousUserMessage())
			expect(scrollToIndex).toHaveBeenCalledWith({ index: 0, align: "start", behavior: "smooth" })

			mountList(result, 4 * ROW_HEIGHT - 32)
			act(() => {
				vi.advanceTimersByTime(1000)
			})
			act(() => result.current.goToNextUserMessage())
			expect(scrollTo).toHaveBeenCalledWith({ top: Number.MAX_SAFE_INTEGER, behavior: "smooth" })
		})
	})

	it("scrolls to the top of the conversation and disables auto-scroll", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))

		const scrollToIndex = vi.fn()
		act(() => {
			;(result.current.virtuosoRef as MutableRefObject<{ scrollToIndex: typeof scrollToIndex } | null>).current = {
				scrollToIndex,
			}
		})

		expect(result.current.isAtTop).toBe(false)

		act(() => {
			result.current.scrollToTopSmooth()
		})

		// Row 0 isn't rendered (no list DOM), so the jump is instant rather than a long smooth scroll.
		expect(scrollToIndex).toHaveBeenCalledWith({
			index: 0,
			align: "start",
			behavior: "auto",
		})
		expect(result.current.disableAutoScrollRef.current).toBe(true)
	})

	it("tracks isAtTop via setIsAtTop", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))

		act(() => {
			result.current.setIsAtTop(true)
		})

		expect(result.current.isAtTop).toBe(true)
	})
})
