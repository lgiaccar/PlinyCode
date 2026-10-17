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

	it("lists the tools and memory buckets in the legend", () => {
		render(
			<ContextWindowSummary
				contextBreakdown={{
					systemPrompt: 2_000,
					rules: 500,
					memory: 500,
					tools: 6_000,
					skills: 400,
					workflows: 600,
					conversation: 10_000,
					other: 0,
				}}
				contextWindow={200_000}
				percentage={10}
				tokenUsed={20_000}
			/>,
		)

		fireEvent.click(screen.getByText("Context Breakdown"))

		const labels = ["System Prompt", "Rules", "Memory", "Tools", "Skills", "Workflows", "Conversation"]
		for (const label of labels) {
			expect(screen.getByText(label)).toBeInTheDocument()
		}
		expect(screen.queryByText("Other")).not.toBeInTheDocument()
		// 6k of 20k: the tool definitions are 30% of the request.
		expect(screen.getByText((_, element) => element?.textContent === "6.0k (30%)")).toBeInTheDocument()
	})

	it("explains where auto condense runs, in tokens and as the setting's share of the input limit", () => {
		render(
			<ContextWindowSummary
				autoCompactThreshold={0.25}
				compactionThreshold={0.7}
				contextWindow={256_000}
				percentage={10}
				tokenUsed={25_600}
			/>,
		)
		fireEvent.click(screen.getByText("Auto Condense Threshold"))
		expect(screen.getByText("25%")).toBeInTheDocument()
		expect(screen.getByText(/Auto condense runs at about 64.0k tokens: 70% of the model's input limit/)).toBeInTheDocument()
		expect(screen.queryByText(/Click the bar to move the marker/)).not.toBeInTheDocument()
	})

	it("says the bar sets the threshold when it can", () => {
		render(
			<ContextWindowSummary
				autoCompactThreshold={0.32}
				canSetThreshold
				contextWindow={256_000}
				percentage={10}
				tokenUsed={25_600}
			/>,
		)
		fireEvent.click(screen.getByText("Auto Condense Threshold"))
		expect(screen.getByText(/Click the bar to move the marker/)).toBeInTheDocument()
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
