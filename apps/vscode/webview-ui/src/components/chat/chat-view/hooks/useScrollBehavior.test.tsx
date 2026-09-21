import { act, renderHook } from "@testing-library/react"
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

	it("navigates to the previous user message", () => {
		const groupedMessages = [
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "say", say: "text", text: "response" },
			{ ts: 3, type: "say", say: "user_feedback", text: "follow up" },
		]
		const { result } = renderHook(() => useScrollBehavior([], [], groupedMessages as any, {}, vi.fn()))

		const scrollToIndex = vi.fn()
		act(() => {
			;(result.current.virtuosoRef as MutableRefObject<{ scrollToIndex: typeof scrollToIndex } | null>).current = {
				scrollToIndex,
			}
		})

		// Simulate viewport showing the middle of the conversation
		act(() => {
			result.current.handleRangeChanged({ startIndex: 2, endIndex: 2 })
		})

		act(() => {
			result.current.goToPreviousUserMessage()
		})

		expect(scrollToIndex).toHaveBeenCalledWith({
			index: 0,
			behavior: "smooth",
			align: "center",
		})
	})

	it("navigates to the next user message", () => {
		const groupedMessages = [
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "say", say: "text", text: "response" },
			{ ts: 3, type: "say", say: "user_feedback", text: "follow up" },
		]
		const { result } = renderHook(() => useScrollBehavior([], [], groupedMessages as any, {}, vi.fn()))

		const scrollToIndex = vi.fn()
		act(() => {
			;(result.current.virtuosoRef as MutableRefObject<{ scrollToIndex: typeof scrollToIndex } | null>).current = {
				scrollToIndex,
			}
		})

		// Simulate viewport showing the start of the conversation
		act(() => {
			result.current.handleRangeChanged({ startIndex: 0, endIndex: 0 })
		})

		act(() => {
			result.current.goToNextUserMessage()
		})

		expect(scrollToIndex).toHaveBeenCalledWith({
			index: 2,
			behavior: "smooth",
			align: "center",
		})
	})

	it("does nothing when there is no previous user message to navigate to", () => {
		const groupedMessages = [
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "say", say: "text", text: "response" },
		]
		const { result } = renderHook(() => useScrollBehavior([], [], groupedMessages as any, {}, vi.fn()))

		const scrollToIndex = vi.fn()
		act(() => {
			;(result.current.virtuosoRef as MutableRefObject<{ scrollToIndex: typeof scrollToIndex } | null>).current = {
				scrollToIndex,
			}
		})

		act(() => {
			result.current.handleRangeChanged({ startIndex: 0, endIndex: 0 })
		})

		act(() => {
			result.current.goToPreviousUserMessage()
		})

		expect(scrollToIndex).not.toHaveBeenCalled()
	})

	it("does nothing when there is no next user message to navigate to", () => {
		const groupedMessages = [
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "say", say: "text", text: "response" },
		]
		const { result } = renderHook(() => useScrollBehavior([], [], groupedMessages as any, {}, vi.fn()))

		const scrollToIndex = vi.fn()
		act(() => {
			;(result.current.virtuosoRef as MutableRefObject<{ scrollToIndex: typeof scrollToIndex } | null>).current = {
				scrollToIndex,
			}
		})

		act(() => {
			result.current.handleRangeChanged({ startIndex: 1, endIndex: 1 })
		})

		act(() => {
			result.current.goToNextUserMessage()
		})

		expect(scrollToIndex).not.toHaveBeenCalled()
	})
})
