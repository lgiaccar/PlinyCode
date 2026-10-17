import type { ClineMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MessageHandlers } from "../../types/chatTypes"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ mode: "act" }),
}))

// A row that throws while rendering when its text says so, standing in for any renderer bug.
vi.mock("@/components/chat/ChatRow", () => ({
	default: ({ message }: { message: ClineMessage }) => {
		if (message.text === "boom") {
			throw new Error("renderer exploded")
		}
		return <div data-testid="row">{message.text}</div>
	},
}))

vi.mock("./ToolGroupRenderer", () => ({
	ToolGroupRenderer: () => <div data-testid="tool-group" />,
}))

import { createMessageRenderer } from "./MessageRenderer"

function message(ts: number, text: string): ClineMessage {
	return { ts, type: "say", say: "text", text, partial: false }
}

function List({ messages }: { messages: ClineMessage[] }) {
	const renderItem = createMessageRenderer(
		messages,
		messages,
		{},
		vi.fn(),
		vi.fn(),
		vi.fn(),
		vi.fn(),
		"",
		{ executeButtonAction: vi.fn(), handleSendMessage: vi.fn() } as unknown as MessageHandlers,
		false,
	)
	return <div>{messages.map((m, index) => renderItem(index, m))}</div>
}

// React (in development) rethrows a caught render error as a window error event, and jsdom
// prints it; a boundary catches it all the same, so keep the test output readable.
const swallowWindowError = (event: ErrorEvent) => event.preventDefault()

describe("createMessageRenderer error boundary", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		window.addEventListener("error", swallowWindowError)
	})

	afterEach(() => {
		window.removeEventListener("error", swallowWindowError)
		vi.restoreAllMocks()
	})

	it("contains a row that throws to that row while its siblings render", () => {
		render(<List messages={[message(1, "first"), message(2, "boom"), message(3, "third")]} />)

		expect(screen.getAllByTestId("row").map((row) => row.textContent)).toEqual(["first", "third"])
		expect(screen.getAllByTestId("undisplayable-message")).toHaveLength(1)
		expect(screen.getByText("This message could not be displayed.")).toBeTruthy()
	})

	it("renders the row normally once its message changes and no longer throws", () => {
		const { rerender } = render(<List messages={[message(1, "first"), message(2, "boom")]} />)
		expect(screen.getAllByTestId("undisplayable-message")).toHaveLength(1)

		rerender(<List messages={[message(1, "first"), message(2, "second, now complete")]} />)

		expect(screen.queryByTestId("undisplayable-message")).toBeNull()
		expect(screen.getAllByTestId("row").map((row) => row.textContent)).toEqual(["first", "second, now complete"])
	})

	it("keeps the fallback while the message stays the same", () => {
		const { rerender } = render(<List messages={[message(1, "boom")]} />)
		rerender(<List messages={[message(1, "boom")]} />)
		expect(screen.getAllByTestId("undisplayable-message")).toHaveLength(1)
	})
})
