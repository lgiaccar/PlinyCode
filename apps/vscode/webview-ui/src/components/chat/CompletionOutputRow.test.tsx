import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CompletionOutputRow } from "./CompletionOutputRow"
import PlanCompletionOutputRow from "./PlanCompletionOutputRow"

vi.mock("./MarkdownRow", () => ({
	MarkdownRow: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}))

vi.mock("@/components/common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}))

const checkpointLatestChangesSummary = vi.fn()
const checkpointOpenFileDiff = vi.fn()
const checkpointViewLatestChanges = vi.fn()

vi.mock("@/services/grpc-client", () => ({
	CheckpointsServiceClient: {
		checkpointLatestChangesSummary: (...args: unknown[]) => checkpointLatestChangesSummary(...args),
		checkpointOpenFileDiff: (...args: unknown[]) => checkpointOpenFileDiff(...args),
		checkpointViewLatestChanges: (...args: unknown[]) => checkpointViewLatestChanges(...args),
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		VSCodeButton: ({
			children,
			disabled,
			onClick,
			...rest
		}: {
			children?: React.ReactNode
			disabled?: boolean
			onClick?: () => void
		}) => (
			<button disabled={disabled} onClick={onClick} type="button" {...rest}>
				{children}
			</button>
		),
	}
})

const hiddenQuoteButton = { visible: false, top: 0, left: 0, selectedText: "" }

const sampleSummary = {
	files: [
		{
			filePath: "/ws/src/a.ts",
			relativePath: "src/a.ts",
			addedLines: 3,
			removedLines: 1,
			status: "modified",
		},
		{
			filePath: "/ws/readme.md",
			relativePath: "readme.md",
			addedLines: 10,
			removedLines: 0,
			status: "added",
		},
	],
	totalAdded: 13,
	totalRemoved: 1,
	checkpointRunCount: 42,
}

describe("CompletionOutputRow", () => {
	const writeText = vi.fn(() => Promise.resolve())

	beforeEach(() => {
		writeText.mockClear()
		Object.assign(navigator, { clipboard: { writeText } })
	})

	it("shows a small Completed header with a copy button", () => {
		render(<CompletionOutputRow handleQuoteClick={vi.fn()} quoteButtonState={hiddenQuoteButton} text="All done!" />)

		expect(screen.getByText("Completed")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Copy response" })).toBeInTheDocument()
	})

	it("copies the response text to the clipboard", async () => {
		render(<CompletionOutputRow handleQuoteClick={vi.fn()} quoteButtonState={hiddenQuoteButton} text="All done!" />)

		fireEvent.click(screen.getByRole("button", { name: "Copy response" }))

		await waitFor(() => expect(writeText).toHaveBeenCalledWith("All done!"))
	})
})

describe("CompletionOutputRow changed files summary", () => {
	beforeEach(() => {
		checkpointLatestChangesSummary.mockReset()
		checkpointOpenFileDiff.mockReset()
		checkpointViewLatestChanges.mockReset()
		checkpointOpenFileDiff.mockResolvedValue({})
		checkpointViewLatestChanges.mockResolvedValue({})
	})

	const renderWithViewChanges = () =>
		render(
			<CompletionOutputRow
				handleQuoteClick={vi.fn()}
				quoteButtonState={hiddenQuoteButton}
				showViewChanges
				text="All done!"
			/>,
		)

	it("shows the summary line once the host returns changed files", async () => {
		checkpointLatestChangesSummary.mockResolvedValue(sampleSummary)

		renderWithViewChanges()

		expect(await screen.findByText("2 files edited, +13 / -1 lines")).toBeInTheDocument()
	})

	it("stays hidden while the summary is loading", () => {
		checkpointLatestChangesSummary.mockReturnValue(new Promise(() => {}))

		renderWithViewChanges()

		expect(screen.queryByText(/files edited/)).toBeNull()
	})

	it("stays hidden when nothing changed", async () => {
		checkpointLatestChangesSummary.mockResolvedValue({
			files: [],
			totalAdded: 0,
			totalRemoved: 0,
			checkpointRunCount: 1,
		})

		renderWithViewChanges()

		await waitFor(() => expect(checkpointLatestChangesSummary).toHaveBeenCalled())
		expect(screen.queryByText(/files edited/)).toBeNull()
	})

	it("stays hidden when the summary request fails", async () => {
		checkpointLatestChangesSummary.mockRejectedValue(new Error("boom"))

		renderWithViewChanges()

		await waitFor(() => expect(checkpointLatestChangesSummary).toHaveBeenCalled())
		expect(screen.queryByText(/files edited/)).toBeNull()
	})

	it("never loads the summary when showViewChanges is not set", () => {
		checkpointLatestChangesSummary.mockResolvedValue(sampleSummary)

		render(<CompletionOutputRow handleQuoteClick={vi.fn()} quoteButtonState={hiddenQuoteButton} text="All done!" />)

		expect(checkpointLatestChangesSummary).not.toHaveBeenCalled()
	})

	it("expands the per-file list and opens a single-file diff on row click", async () => {
		checkpointLatestChangesSummary.mockResolvedValue(sampleSummary)

		renderWithViewChanges()
		await screen.findByText("2 files edited, +13 / -1 lines")

		fireEvent.click(screen.getByRole("button", { name: /2 files edited/ }))

		const fileRow = screen.getByRole("button", { name: /readme\.md/ })
		fireEvent.click(fileRow)

		await waitFor(() =>
			expect(checkpointOpenFileDiff).toHaveBeenCalledWith(
				expect.objectContaining({
					filePath: "/ws/readme.md",
					checkpointRunCount: 42,
				}),
			),
		)
	})

	it("re-checks instead of reusing stale summary when showViewChanges toggles", async () => {
		checkpointLatestChangesSummary.mockResolvedValue(sampleSummary)

		const { rerender } = renderWithViewChanges()
		await screen.findByText("2 files edited, +13 / -1 lines")

		rerender(<CompletionOutputRow handleQuoteClick={vi.fn()} quoteButtonState={hiddenQuoteButton} text="All done!" />)
		expect(screen.queryByText(/files edited/)).toBeNull()

		checkpointLatestChangesSummary.mockReturnValue(new Promise(() => {}))
		rerender(
			<CompletionOutputRow
				handleQuoteClick={vi.fn()}
				quoteButtonState={hiddenQuoteButton}
				showViewChanges
				text="All done!"
			/>,
		)
		expect(checkpointLatestChangesSummary).toHaveBeenCalledTimes(2)
		expect(screen.queryByText(/files edited/)).toBeNull()
	})
})

describe("PlanCompletionOutputRow", () => {
	const writeText = vi.fn(() => Promise.resolve())

	beforeEach(() => {
		writeText.mockClear()
		Object.assign(navigator, { clipboard: { writeText } })
	})

	it("shows a small Plan header with a copy button", () => {
		render(<PlanCompletionOutputRow text="Here is the plan" />)

		expect(screen.getByText("Plan")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Copy plan response" })).toBeInTheDocument()
	})

	it("copies the plan response text to the clipboard", async () => {
		render(<PlanCompletionOutputRow text="Here is the plan" />)

		fireEvent.click(screen.getByRole("button", { name: "Copy plan response" }))

		await waitFor(() => expect(writeText).toHaveBeenCalledWith("Here is the plan"))
	})
})
