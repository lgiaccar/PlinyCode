import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import TaskUsageCounter, { parseBudget, totalTaskTokens } from "./TaskUsageCounter"

describe("TaskUsageCounter", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date(2026, 8, 25, 18, 0, 0))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("shows time, tokens and cost together", () => {
		render(
			<TaskUsageCounter
				activeMs={125_000}
				cacheReads={2_000}
				cacheWrites={500}
				tokensIn={40_000}
				tokensOut={3_000}
				totalCost={0.1234}
			/>,
		)
		const counter = screen.getByTestId("task-usage-counter")
		expect(counter.textContent).toContain("2m 5s")
		expect(counter.textContent).toContain("45.5k tok")
		expect(counter.textContent).toContain("$0.1234")
	})

	it("leaves the cost out when the provider reports none", () => {
		render(<TaskUsageCounter tokensIn={1_000} tokensOut={200} />)
		expect(screen.getByTestId("task-usage-counter").textContent).not.toContain("$")
	})

	it("marks estimated usage", () => {
		render(<TaskUsageCounter hasEstimatedUsage tokensIn={1_000} tokensOut={0} totalCost={0.5} />)
		const counter = screen.getByTestId("task-usage-counter")
		expect(counter.textContent).toContain("~1.0k tok")
		expect(counter.textContent).toContain("~$0.5000")
	})

	it("ticks while the agent is running", () => {
		render(<TaskUsageCounter activeMs={10_000} runningSinceTs={Date.now()} tokensIn={0} tokensOut={0} />)
		expect(screen.getByTestId("task-usage-counter").textContent).toContain("10s")
		act(() => {
			vi.advanceTimersByTime(5_000)
		})
		expect(screen.getByTestId("task-usage-counter").textContent).toContain("15s")
	})

	it("puts the start time in the tooltip", () => {
		render(<TaskUsageCounter startedTs={new Date(2026, 8, 25, 17, 53).getTime()} tokensIn={10} tokensOut={5} />)
		expect(screen.getByTestId("task-usage-counter").getAttribute("title")).toContain("Started Today, 5:53 PM")
	})

	it("shows the cost against the conversation's budget", () => {
		render(<TaskUsageCounter budget={5} tokensIn={1_000} tokensOut={200} totalCost={1.25} />)
		expect(screen.getByTestId("task-usage-counter").textContent).toContain("$1.2500/$5.00")
		expect(screen.getByTestId("task-usage-counter").getAttribute("title")).toContain("Budget $5.00")
	})

	it("shows no budget for free models, and 'no limit' for a budget of 0", () => {
		const { rerender } = render(<TaskUsageCounter tokensIn={1_000} tokensOut={200} totalCost={0} />)
		expect(screen.queryByTestId("task-budget")).toBeNull()
		rerender(<TaskUsageCounter budget={0} tokensIn={1_000} tokensOut={200} totalCost={0} />)
		expect(screen.getByTestId("task-budget").textContent).toBe("no limit")
	})

	it("edits the budget inline: Enter saves, Escape cancels", () => {
		const onBudgetChange = vi.fn()
		render(<TaskUsageCounter budget={5} onBudgetChange={onBudgetChange} tokensIn={1} tokensOut={1} totalCost={1} />)

		fireEvent.click(screen.getByTestId("task-budget"))
		const input = screen.getByLabelText("Conversation budget in USD (0 = no limit)")
		fireEvent.change(input, { target: { value: "$12.5" } })
		fireEvent.keyDown(input, { key: "Enter" })
		expect(onBudgetChange).toHaveBeenCalledWith(12.5)

		fireEvent.click(screen.getByTestId("task-budget"))
		const again = screen.getByLabelText("Conversation budget in USD (0 = no limit)")
		fireEvent.change(again, { target: { value: "99" } })
		fireEvent.keyDown(again, { key: "Escape" })
		expect(onBudgetChange).toHaveBeenCalledTimes(1)
	})

	it("renders nothing for an empty conversation", () => {
		const { container } = render(<TaskUsageCounter tokensIn={0} tokensOut={0} />)
		expect(container.firstChild).toBeNull()
	})
})

describe("parseBudget", () => {
	it("reads dollars with or without a sign, and a blank as no limit", () => {
		expect(parseBudget("7.5")).toBe(7.5)
		expect(parseBudget(" $10 ")).toBe(10)
		expect(parseBudget("")).toBe(0)
		expect(parseBudget("-1")).toBeUndefined()
		expect(parseBudget("ten")).toBeUndefined()
	})
})

describe("totalTaskTokens", () => {
	it("adds input, output and cache traffic", () => {
		expect(totalTaskTokens({ tokensIn: 1, tokensOut: 2, cacheWrites: 3, cacheReads: 4 })).toBe(10)
		expect(totalTaskTokens({ tokensIn: 1, tokensOut: 2 })).toBe(3)
	})
})
