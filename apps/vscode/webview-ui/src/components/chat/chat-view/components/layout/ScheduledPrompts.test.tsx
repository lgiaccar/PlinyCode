import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { type ScheduledPrompt, ScheduledPrompts } from "./ScheduledPrompts"

// A fixed timestamp so formatted time assertions are deterministic.
// 2026-01-15 09:30 UTC
const FIXED_TS = new Date("2026-01-15T09:30:00.000Z").getTime()

const makeItem = (overrides: Partial<ScheduledPrompt> = {}): ScheduledPrompt => ({
	id: "item-1",
	text: "Send the daily summary report",
	images: [],
	files: [],
	scheduledAt: FIXED_TS,
	...overrides,
})

describe("ScheduledPrompts", () => {
	it("does not render when items list is empty", () => {
		const { container } = render(<ScheduledPrompts items={[]} onCancel={vi.fn()} />)

		expect(container).toBeEmptyDOMElement()
	})

	it("shows singular header for one scheduled message", () => {
		render(<ScheduledPrompts items={[makeItem()]} onCancel={vi.fn()} />)

		expect(screen.getByText("Scheduled message")).toBeInTheDocument()
	})

	it("shows plural header for multiple scheduled messages", () => {
		const items = [
			makeItem({ id: "item-1" }),
			makeItem({ id: "item-2", text: "Run the lint checks" }),
			makeItem({ id: "item-3", text: "Deploy to staging" }),
		]

		render(<ScheduledPrompts items={items} onCancel={vi.fn()} />)

		expect(screen.getByText("3 scheduled messages")).toBeInTheDocument()
	})

	it("renders the full prompt text when it is 96 characters or shorter", () => {
		const text = "A".repeat(96)
		render(<ScheduledPrompts items={[makeItem({ text })]} onCancel={vi.fn()} />)

		expect(screen.getByText(text)).toBeInTheDocument()
	})

	it("truncates prompt text longer than 96 characters", () => {
		const text = "B".repeat(100)
		render(<ScheduledPrompts items={[makeItem({ text })]} onCancel={vi.fn()} />)

		expect(screen.getByText(`${"B".repeat(96)}...`)).toBeInTheDocument()
		expect(screen.queryByText(text)).not.toBeInTheDocument()
	})

	it("calls onCancel with the item id when the cancel button is clicked", () => {
		const onCancel = vi.fn()
		render(<ScheduledPrompts items={[makeItem({ id: "sched-42" })]} onCancel={onCancel} />)

		const cancelButton = screen.getByRole("button", { name: "Cancel scheduled message" })
		fireEvent.click(cancelButton)

		expect(onCancel).toHaveBeenCalledTimes(1)
		expect(onCancel).toHaveBeenCalledWith("sched-42")
	})

	it("disables the cancel button after it is clicked", () => {
		const onCancel = vi.fn()
		render(<ScheduledPrompts items={[makeItem()]} onCancel={onCancel} />)

		const cancelButton = screen.getByRole("button", { name: "Cancel scheduled message" })
		fireEvent.click(cancelButton)

		expect(cancelButton).toBeDisabled()
	})

	it("renders a cancel button for each scheduled item", () => {
		const items = [makeItem({ id: "a", text: "First" }), makeItem({ id: "b", text: "Second" })]

		render(<ScheduledPrompts items={items} onCancel={vi.fn()} />)

		const cancelButtons = screen.getAllByRole("button", { name: "Cancel scheduled message" })
		expect(cancelButtons).toHaveLength(2)
	})

	it("only disables the clicked cancel button, not others", () => {
		const items = [makeItem({ id: "a", text: "First message" }), makeItem({ id: "b", text: "Second message" })]

		render(<ScheduledPrompts items={items} onCancel={vi.fn()} />)

		const [firstButton, secondButton] = screen.getAllByRole("button", { name: "Cancel scheduled message" })
		fireEvent.click(firstButton)

		expect(firstButton).toBeDisabled()
		expect(secondButton).not.toBeDisabled()
	})
})
