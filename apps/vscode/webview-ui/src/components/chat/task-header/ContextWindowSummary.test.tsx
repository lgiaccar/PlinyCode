import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ContextWindowSummary } from "./ContextWindowSummary"

describe("ContextWindowSummary context breakdown", () => {
	it("renders the breakdown accordion with per-source tokens and percentages", () => {
		render(
			<ContextWindowSummary
				contextBreakdown={{
					systemPrompt: 600,
					rules: 200,
					skills: 0,
					workflows: 0,
					conversation: 1200,
					other: 0,
				}}
				contextWindow={200_000}
				percentage={1}
				tokenUsed={2_000}
			/>,
		)

		fireEvent.click(screen.getByText("Context Breakdown"))

		expect(screen.getByText("System Prompt")).toBeInTheDocument()
		expect(screen.getByText("Rules")).toBeInTheDocument()
		expect(screen.getByText("Conversation")).toBeInTheDocument()
		// Zero-value sections (skills, workflows, other) are omitted.
		expect(screen.queryByText("Skills")).not.toBeInTheDocument()
		expect(screen.queryByText("Workflows")).not.toBeInTheDocument()
		expect(screen.queryByText("Other")).not.toBeInTheDocument()

		// 600 + 200 + 1200 = 2000 total: system prompt is 30%, conversation is 60%.
		expect(screen.getByText((_, element) => element?.textContent === "600 (30%)")).toBeInTheDocument()
		expect(screen.getByText((_, element) => element?.textContent === "1.2k (60%)")).toBeInTheDocument()
	})

	it("omits the breakdown section entirely when no breakdown is provided", () => {
		render(<ContextWindowSummary contextWindow={200_000} percentage={1} tokenUsed={2_000} />)
		expect(screen.queryByText("Context Breakdown")).not.toBeInTheDocument()
	})

	it("omits the breakdown section when every bucket is zero", () => {
		render(
			<ContextWindowSummary
				contextBreakdown={{ systemPrompt: 0, rules: 0, skills: 0, workflows: 0, conversation: 0, other: 0 }}
				contextWindow={200_000}
				percentage={1}
				tokenUsed={0}
			/>,
		)
		expect(screen.queryByText("Context Breakdown")).not.toBeInTheDocument()
	})

	it("prefixes token counts and percentage with ~ when usage is estimated", () => {
		render(<ContextWindowSummary contextWindow={200_000} hasEstimatedUsage percentage={1.5} tokenUsed={3_000} />)

		expect(screen.getByText(/~1\.5%/)).toBeInTheDocument()
	})
})
