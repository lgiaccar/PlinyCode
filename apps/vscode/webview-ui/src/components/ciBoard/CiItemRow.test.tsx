import type { CiActionInfo, CiItem } from "@shared/proto/cline/ci_board"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CiItemRow } from "./CiItemRow"
import { classifyCiInput, pipelineTitle } from "./ciBoardUtils"

const mocks = vi.hoisted(() => ({
	runCiAction: vi.fn(),
	openCiConversation: vi.fn(),
	openUrl: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	CiBoardServiceClient: { runCiAction: mocks.runCiAction, openCiConversation: mocks.openCiConversation },
	UiServiceClient: { openUrl: mocks.openUrl },
}))

const FIX: CiActionInfo = { id: "fix", label: "Fix CI & conflicts", promptKind: "builtin", promptValue: "", trigger: "manual" }

function makeItem(overrides: Partial<CiItem> = {}): CiItem {
	return {
		key: "github|github.com|octo/hello#12",
		prId: 12,
		title: "Speed up meshing",
		url: "https://github.com/octo/hello/pull/12",
		sourceBranch: "feature",
		targetBranch: "stage",
		author: "me",
		draft: false,
		state: "open",
		headSha: "abc",
		mergeState: "clean",
		pipelines: [
			{ name: "win_cpu", color: "red", status: "completed", result: "failure", runId: 101, url: "https://ci/101" },
			{ name: "linux_cpu", color: "green", status: "completed", result: "success", runId: 102, url: "https://ci/102" },
			{ name: "win_cuda", color: "grey", status: "", result: "", runId: 0, url: "" },
		],
		conversationId: "",
		conversationStatus: "",
		watching: false,
		runBlocked: "",
		error: "",
		...overrides,
	}
}

describe("CiItemRow", () => {
	beforeEach(() => {
		mocks.runCiAction.mockReset().mockResolvedValue({ value: "conv-1" })
		mocks.openCiConversation.mockReset().mockResolvedValue({})
		mocks.openUrl.mockReset().mockResolvedValue({})
	})

	it("shows one dot per pipeline in its color, and opens a run from its dot", () => {
		render(<CiItemRow actions={[FIX]} item={makeItem()} targetId="t1" />)
		const dots = screen.getByTestId("pipeline-dots").querySelectorAll("button")
		expect([...dots].map((d) => d.getAttribute("data-color"))).toEqual(["red", "green", "grey"])
		expect(dots[2]).toBeDisabled()
		fireEvent.click(dots[0])
		expect(mocks.openUrl).toHaveBeenCalledWith(expect.objectContaining({ value: "https://ci/101" }))
	})

	it("flags merge conflicts", () => {
		const { rerender } = render(<CiItemRow actions={[FIX]} item={makeItem()} targetId="t1" />)
		expect(screen.queryByTestId("merge-badge")).toBeNull()
		rerender(<CiItemRow actions={[FIX]} item={makeItem({ mergeState: "conflicts" })} targetId="t1" />)
		expect(screen.getByTestId("merge-badge")).toHaveTextContent("Conflicts")
	})

	it("runs the action for the item, and shows why when it cannot", async () => {
		const { rerender } = render(<CiItemRow actions={[FIX]} item={makeItem()} targetId="t1" />)
		fireEvent.click(screen.getByRole("button", { name: /Fix CI & conflicts/ }))
		await waitFor(() =>
			expect(mocks.runCiAction).toHaveBeenCalledWith(
				expect.objectContaining({ targetId: "t1", itemKey: "github|github.com|octo/hello#12", actionId: "fix" }),
			),
		)

		mocks.runCiAction.mockRejectedValueOnce(new Error("Could not fetch 'feature'"))
		fireEvent.click(screen.getByRole("button", { name: /Fix CI & conflicts/ }))
		expect(await screen.findByText("Could not fetch 'feature'")).toBeInTheDocument()

		rerender(
			<CiItemRow actions={[FIX]} item={makeItem({ runBlocked: "This pull request comes from a fork." })} targetId="t1" />,
		)
		expect(screen.getByRole("button", { name: /Fix CI & conflicts/ })).toBeDisabled()
	})

	it("links the conversation an action started", () => {
		render(
			<CiItemRow
				actions={[FIX]}
				item={makeItem({ conversationId: "conv-1", conversationStatus: "background", watching: true })}
				targetId="t1"
			/>,
		)
		fireEvent.click(screen.getByText("Running in background"))
		expect(mocks.openCiConversation).toHaveBeenCalledWith(
			expect.objectContaining({ value: "github|github.com|octo/hello#12" }),
		)
	})
})

describe("ciBoardUtils", () => {
	it("tells pull request links from branch names", () => {
		expect(classifyCiInput("https://github.com/octo/hello/pull/12")).toBe("pr")
		expect(classifyCiInput("https://ado.example.com/tfs/C/P/_git/r/pullrequest/7?_a=files")).toBe("pr")
		expect(classifyCiInput("lgiaccar/feature")).toBe("branch")
		expect(classifyCiInput("  ")).toBe("empty")
	})

	it("describes a pipeline for its tooltip", () => {
		const base = { name: "ci", color: "", status: "", result: "", runId: 0, url: "" }
		expect(pipelineTitle(base)).toBe("ci: no run on this commit")
		expect(pipelineTitle({ ...base, status: "in_progress", runId: 4 })).toBe("ci: running · run 4")
		expect(pipelineTitle({ ...base, status: "completed", result: "failure" })).toBe("ci: failure")
	})
})
