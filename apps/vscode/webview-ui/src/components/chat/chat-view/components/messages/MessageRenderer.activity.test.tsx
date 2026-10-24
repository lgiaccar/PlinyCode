import type { ClineMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { groupActivityRows } from "../../utils/activityGroups"
import { createMessageRenderer } from "./MessageRenderer"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ mode: "act", turnState: { phase: "completed" } }),
}))

vi.mock("@/components/chat/ChatRow", () => ({
	default: ({ message }: { message: ClineMessage }) => <div>{message.text}</div>,
}))

vi.mock("./ToolGroupRenderer", () => ({
	ToolGroupRenderer: ({ messages }: { messages: ClineMessage[] }) => <div>{messages.map((message) => message.text)}</div>,
}))

const say = (ts: number, kind: ClineMessage["say"], text: string): ClineMessage => ({
	ts,
	type: "say",
	say: kind,
	text,
})

describe("activity disclosure", () => {
	it("shows only the answer until the user expands the activity", async () => {
		const rows = groupActivityRows([
			say(1, "reasoning", "Private thinking"),
			say(2, "tool", "Web search results"),
			say(3, "completion_result", "Final answer"),
		])
		const onActivityToggle = vi.fn()
		function ActivityList({ showActivity = true }: { showActivity?: boolean }) {
			const [expanded, setExpanded] = useState<Record<number, boolean>>({})
			const renderItem = createMessageRenderer(rows, [], {}, vi.fn(), vi.fn(), vi.fn(), vi.fn(), "", {} as never, false, {
				isExpanded: (ts) => expanded[ts] ?? false,
				onToggle: (ts) => {
					onActivityToggle()
					setExpanded((current) => ({ ...current, [ts]: !current[ts] }))
				},
			})
			return <div>{rows.map((row, index) => (showActivity || index > 0 ? renderItem(index, row) : null))}</div>
		}
		const { rerender } = render(<ActivityList />)
		const disclosure = screen.getByRole("button", { name: "Show activity" })
		expect(disclosure).toHaveAttribute("aria-expanded", "false")
		expect(screen.getByText("Final answer")).toBeInTheDocument()
		expect(screen.queryByText("Web search results")).toBeNull()
		await userEvent.setup().click(disclosure)
		expect(disclosure).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByText("Web search results")).toBeInTheDocument()
		expect(screen.getByText("Private thinking")).toBeInTheDocument()
		expect(onActivityToggle).toHaveBeenCalledTimes(1)
		rerender(<ActivityList showActivity={false} />)
		rerender(<ActivityList />)
		expect(screen.getByRole("button", { name: "Hide activity" })).toHaveAttribute("aria-expanded", "true")
		const reopenedDisclosure = screen.getByRole("button", { name: "Hide activity" })
		reopenedDisclosure.focus()
		await userEvent.setup().keyboard("{Enter}")
		expect(reopenedDisclosure).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByText("Web search results")).toBeNull()
	})
})

describe("turn dividers", () => {
	it("keeps a labeled divider with each prompt row without inserting virtualized rows", () => {
		const rows = [
			say(2, "text", "First answer"),
			{ ...say(3, "user_feedback", "Approved"), answersTool: true },
			say(4, "user_feedback", "Second prompt"),
			say(5, "reasoning", "working"),
			{ ...say(6, "user_feedback", "Side prompt"), offTheRecord: true },
		]
		const renderItem = createMessageRenderer(rows, rows, {}, vi.fn(), vi.fn(), vi.fn(), vi.fn(), "", {} as never, false, {
			isExpanded: () => false,
			onToggle: vi.fn(),
		})
		render(<div>{rows.map((row, index) => renderItem(index, row))}</div>)
		const boundaries = screen.getAllByRole("heading", { level: 3 })
		expect(boundaries.map((boundary) => boundary.textContent)).toEqual(["Follow-up 2", "Side question 3"])
		expect(boundaries[0].closest("[data-message-ts]")).toHaveAttribute("data-message-ts", "4")
		expect(boundaries[1].closest("[data-message-ts]")).toHaveAttribute("data-message-ts", "6")
		expect(screen.getByText("Approved")).toBeInTheDocument()
	})
})
