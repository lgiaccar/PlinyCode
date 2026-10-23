import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ThinkingRow } from "./ThinkingRow"

describe("ThinkingRow", () => {
	it("renders streaming status with reasoning hidden until expanded", () => {
		const onToggle = vi.fn()
		render(
			<ThinkingRow
				isExpanded={false}
				isStreaming={true}
				isVisible={true}
				onToggle={onToggle}
				reasoningContent="Inspecting files..."
				showTitle={true}
				title="Thinking..."
			/>,
		)

		const title = screen.getByText("Thinking...")
		expect(title).toBeInTheDocument()
		expect(title).toHaveClass("animate-shimmer")
		expect(screen.queryByText("Inspecting files...")).not.toBeInTheDocument()
		const disclosure = screen.getByRole("button", { name: "Thinking..." })
		expect(disclosure).toHaveAttribute("aria-expanded", "false")
		fireEvent.click(disclosure)
		expect(onToggle).toHaveBeenCalledTimes(1)
	})

	it("calls onToggle when header is clicked", () => {
		const onToggle = vi.fn()

		render(
			<ThinkingRow
				isExpanded={false}
				isVisible={true}
				onToggle={onToggle}
				reasoningContent="some reasoning"
				showTitle={true}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Thinking/i }))
		expect(onToggle).toHaveBeenCalledTimes(1)
	})

	it("exposes expanded state and supports keyboard toggling", async () => {
		const onToggle = vi.fn()
		const { rerender } = render(
			<ThinkingRow
				isExpanded={false}
				isVisible={true}
				onToggle={onToggle}
				reasoningContent="some reasoning"
				showTitle={true}
			/>,
		)
		const disclosure = screen.getByRole("button", { name: "Thinking" })
		const user = userEvent.setup()
		await user.tab()
		expect(disclosure).toHaveFocus()
		await user.keyboard("{Enter}")
		expect(onToggle).toHaveBeenCalledTimes(1)
		rerender(
			<ThinkingRow
				isExpanded={true}
				isVisible={true}
				onToggle={onToggle}
				reasoningContent="some reasoning"
				showTitle={true}
			/>,
		)
		expect(disclosure).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByText("some reasoning")).toBeInTheDocument()
		expect(document.getElementById(disclosure.getAttribute("aria-controls") ?? "")).toContainElement(
			screen.getByText("some reasoning"),
		)
	})
})
