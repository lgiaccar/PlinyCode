import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import TaskUsageCounter, { totalTaskTokens } from "./TaskUsageCounter"

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

	it("renders nothing for an empty conversation", () => {
		const { container } = render(<TaskUsageCounter tokensIn={0} tokensOut={0} />)
		expect(container.firstChild).toBeNull()
	})
})

describe("totalTaskTokens", () => {
	it("adds input, output and cache traffic", () => {
		expect(totalTaskTokens({ tokensIn: 1, tokensOut: 2, cacheWrites: 3, cacheReads: 4 })).toBe(10)
		expect(totalTaskTokens({ tokensIn: 1, tokensOut: 2 })).toBe(3)
	})
})
