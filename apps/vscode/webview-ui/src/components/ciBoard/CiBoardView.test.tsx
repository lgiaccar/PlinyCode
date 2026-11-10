import { CiBoardState, CiItem, CiTargetView } from "@shared/proto/cline/ci_board"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import CiBoardView from "./CiBoardView"

const mocks = vi.hoisted(() => ({ board: {} as unknown, refresh: vi.fn() }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ environment: "test" }) }))
vi.mock("../common/ViewHeader", () => ({ default: () => <h1>CI Board</h1> }))
vi.mock("./AddCiTargetForm", () => ({ AddCiTargetForm: () => null }))
vi.mock("@/services/grpc-client", () => ({
	CiBoardServiceClient: {
		subscribeToCiBoard: (_request: unknown, handler: { onResponse: (board: unknown) => void }) => {
			handler.onResponse(mocks.board)
			return () => {}
		},
		refreshCiBoard: mocks.refresh,
	},
	UiServiceClient: { openUrl: vi.fn() },
	FileServiceClient: { openFile: vi.fn() },
}))

const item = (key: string, patch: Partial<CiItem> = {}) =>
	CiItem.create({
		key,
		title: key,
		prId: 42,
		sourceBranch: "feature",
		targetBranch: "stage",
		state: "open",
		headSha: "abcdef123456",
		mergeState: "clean",
		checkedTs: Date.now() - 120_000,
		pipelines: [{ name: "CI", color: "green" }],
		...patch,
	})

describe("CI Board overview", () => {
	beforeEach(() => {
		mocks.refresh.mockReset().mockResolvedValue({})
		mocks.board = CiBoardState.create({
			targets: [
				CiTargetView.create({
					id: "t",
					label: "octo/mesh",
					provider: "github",
					kind: "repo",
					checkout: "/repo",
					items: [
						item("Ready change"),
						item("Draft change", { draft: true }),
						item("Expired change", { expiredBuildPolicies: [{ evaluationId: "p", name: "CI", buildId: 7 }] }),
						item("Broken change", {
							pipelines: [{ name: "CI", color: "red", status: "completed", result: "failure", runId: 3, url: "" }],
						}),
					],
				}),
			],
		})
	})

	it("filters visible rows, reports empty results, and restores them with Clear filters", () => {
		render(<CiBoardView onDone={() => {}} />)
		expect(screen.getAllByTestId("ci-item")).toHaveLength(4)
		fireEvent.click(screen.getByRole("button", { name: /^CI ready/ }))
		expect(screen.getAllByTestId("ci-item")).toHaveLength(1)
		expect(screen.getByTestId("ci-item")).toHaveTextContent("Ready change")
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "expired" } })
		expect(screen.queryByTestId("ci-item")).not.toBeInTheDocument()
		expect(screen.getByText("No matching pull requests or branches.")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: /^Expired/ }))
		expect(screen.getByTestId("ci-item")).toHaveTextContent("Expired change")
		expect(screen.getByTestId("ci-item-status")).toHaveTextContent("All build validations must be current and approved")
		fireEvent.click(screen.getByRole("button", { name: "Clear filters" }))
		expect(screen.getAllByTestId("ci-item")).toHaveLength(4)
		expect(screen.getByRole("searchbox")).toHaveValue("")
	})

	it("keeps a repository fetch error visible under filters and excludes its cached green row from CI ready", () => {
		const board = mocks.board as CiBoardState
		board.targets[0].error = "Repository refresh failed"
		render(<CiBoardView onDone={() => {}} />)
		for (const button of screen.getAllByRole("button", { name: "Merge", exact: true })) expect(button).toBeDisabled()
		fireEvent.click(screen.getByRole("button", { name: /^CI ready/ }))
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no-match" } })
		expect(screen.getByText("Repository refresh failed")).toBeInTheDocument()
		expect(screen.queryByTestId("ci-item")).not.toBeInTheDocument()
	})

	it("reports Refresh all errors and enables retry", async () => {
		mocks.refresh.mockRejectedValueOnce(new Error("Refresh unavailable"))
		render(<CiBoardView onDone={() => {}} />)
		fireEvent.click(screen.getByRole("button", { name: "Refresh all" }))
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Refresh unavailable"))
		expect(screen.getByRole("button", { name: "Refresh all" })).toBeEnabled()
		fireEvent.click(screen.getByRole("button", { name: "Refresh all" }))
		await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
	})
})
