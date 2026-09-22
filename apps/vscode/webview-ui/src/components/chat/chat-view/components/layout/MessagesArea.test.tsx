import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ChatState, MessageHandlers, ScrollBehavior } from "../../types/chatTypes"
import { MessagesArea } from "./MessagesArea"

vi.mock("../../../../../context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ clineMessages: [], turnState: undefined }),
}))

vi.mock("../../hooks/useThinkingLoaderRow", () => ({
	useThinkingLoaderRow: () => false,
}))

vi.mock("@/components/chat/task-header/StickyUserMessage", () => ({
	StickyUserMessage: () => null,
}))

vi.mock("@/components/chat/ChatRow", () => ({
	default: () => null,
}))

vi.mock("../messages/MessageRenderer", () => ({
	createMessageRenderer: () => () => null,
}))

const scrollToIndex = vi.fn()

// Minimal Virtuoso stand-in: exposes the rangeChanged/atTopStateChange/atBottomStateChange
// callbacks the component relies on, without pulling in real virtualization/measurement.
vi.mock("react-virtuoso", async () => {
	const React = await import("react")
	return {
		Virtuoso: React.forwardRef((_props: unknown, ref: React.Ref<{ scrollToIndex: typeof scrollToIndex }>) => {
			React.useImperativeHandle(ref, () => ({ scrollToIndex }))
			return <div data-testid="virtuoso" />
		}),
	}
})

function makeMessage(ts: number, say: ClineMessage["say"], text: string): ClineMessage {
	return { ts, type: "say", say, text, partial: false }
}

function makeScrollBehavior(overrides: Partial<ScrollBehavior> = {}): ScrollBehavior {
	return {
		virtuosoRef: { current: null },
		scrollContainerRef: { current: null },
		disableAutoScrollRef: { current: false },
		scrollToBottomSmooth: vi.fn(),
		scrollToBottomAuto: vi.fn(),
		scrollToTopSmooth: vi.fn(),
		scrollToMessage: vi.fn(),
		toggleRowExpansion: vi.fn(),
		handleRowHeightChange: vi.fn(),
		handleLastRowContentChange: vi.fn(),
		isAtBottom: true,
		setIsAtBottom: vi.fn(),
		isAtTop: true,
		setIsAtTop: vi.fn(),
		pendingScrollToMessage: null,
		setPendingScrollToMessage: vi.fn(),
		scrolledPastUserMessage: null,
		handleRangeChanged: vi.fn(),
		goToPreviousUserMessage: vi.fn(),
		goToNextUserMessage: vi.fn(),
		userMessageIndices: [],
		...overrides,
	} as ScrollBehavior
}

function makeChatState(): ChatState {
	return {
		expandedRows: {},
		inputValue: "",
		setActiveQuote: vi.fn(),
	} as unknown as ChatState
}

function makeMessageHandlers(): MessageHandlers {
	return {
		executeButtonAction: vi.fn(),
		handleSendMessage: vi.fn(),
		handleTaskCloseButtonClick: vi.fn(),
		startNewTask: vi.fn(),
	} as unknown as MessageHandlers
}

describe("MessagesArea", () => {
	it("shows the scroll-to-top button even when Virtuoso reports at-top", () => {
		const task = makeMessage(1, "task", "hello")
		const groupedMessages = [task, makeMessage(2, "text", "response"), makeMessage(3, "user_feedback", "follow up")]

		render(
			<MessagesArea
				chatState={makeChatState()}
				groupedMessages={groupedMessages}
				messageHandlers={makeMessageHandlers()}
				modifiedMessages={groupedMessages as ClineMessage[]}
				scrollBehavior={makeScrollBehavior({ isAtTop: true, isAtBottom: false, userMessageIndices: [0, 2] })}
				task={task}
			/>,
		)

		expect(screen.getByTitle("Scroll to top")).toBeInTheDocument()
	})

	it("shows the scroll-to-top button when not at the top and scrolls on click", () => {
		const task = makeMessage(1, "task", "hello")
		const groupedMessages = [task, makeMessage(2, "text", "response"), makeMessage(3, "user_feedback", "follow up")]
		const scrollToTopSmooth = vi.fn()

		render(
			<MessagesArea
				chatState={makeChatState()}
				groupedMessages={groupedMessages}
				messageHandlers={makeMessageHandlers()}
				modifiedMessages={groupedMessages as ClineMessage[]}
				scrollBehavior={makeScrollBehavior({
					isAtTop: false,
					scrollToTopSmooth,
					userMessageIndices: [0, 2],
				})}
				task={task}
			/>,
		)

		const button = screen.getByTitle("Scroll to top")
		fireEvent.click(button)
		expect(scrollToTopSmooth).toHaveBeenCalledTimes(1)
	})

	it("renders one marker per user message and hides them below the 3-message threshold", () => {
		const task = makeMessage(1, "task", "hello")
		const groupedMessages = [task, makeMessage(2, "text", "response"), makeMessage(3, "user_feedback", "follow up")]

		const { rerender } = render(
			<MessagesArea
				chatState={makeChatState()}
				groupedMessages={groupedMessages}
				messageHandlers={makeMessageHandlers()}
				modifiedMessages={groupedMessages as ClineMessage[]}
				scrollBehavior={makeScrollBehavior({ userMessageIndices: [0, 2] })}
				task={task}
			/>,
		)

		// Only 2 user messages: below the 3-message threshold, overlay hidden.
		expect(screen.queryAllByRole("button", { name: "" }).filter((btn) => btn.title !== "")).toHaveLength(0)

		const threeUserMessages = [
			task,
			makeMessage(2, "user_feedback", "second message here"),
			makeMessage(3, "user_feedback", "third message here"),
		]

		rerender(
			<MessagesArea
				chatState={makeChatState()}
				groupedMessages={threeUserMessages}
				messageHandlers={makeMessageHandlers()}
				modifiedMessages={threeUserMessages as ClineMessage[]}
				scrollBehavior={makeScrollBehavior({ userMessageIndices: [0, 1, 2] })}
				task={task}
			/>,
		)

		expect(screen.getByTitle("hello")).toBeInTheDocument()
		expect(screen.getByTitle("second message here")).toBeInTheDocument()
		expect(screen.getByTitle("third message here")).toBeInTheDocument()
	})

	it("clicking a marker scrolls to its index and disables auto-scroll", () => {
		const task = makeMessage(1, "task", "hello")
		const groupedMessages = [
			task,
			makeMessage(2, "user_feedback", "second message"),
			makeMessage(3, "text", "response"),
			makeMessage(4, "user_feedback", "third message"),
		]
		const disableAutoScrollRef = { current: false }

		render(
			<MessagesArea
				chatState={makeChatState()}
				groupedMessages={groupedMessages}
				messageHandlers={makeMessageHandlers()}
				modifiedMessages={groupedMessages as ClineMessage[]}
				scrollBehavior={makeScrollBehavior({
					disableAutoScrollRef,
					userMessageIndices: [0, 1, 3],
				})}
				task={task}
			/>,
		)

		fireEvent.click(screen.getByTitle("third message"))

		expect(scrollToIndex).toHaveBeenCalledWith({
			index: 3,
			align: "start",
			behavior: "smooth",
		})
		expect(disableAutoScrollRef.current).toBe(true)
	})
})
