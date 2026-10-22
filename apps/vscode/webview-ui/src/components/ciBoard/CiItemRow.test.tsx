import type { CiItem, CiItemAction, CiPipelineFix, CiTriage } from "@shared/proto/cline/ci_board"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CiItemRow } from "./CiItemRow"
import { classifyCiInput, itemRank, pipelineTitle, timeAgo } from "./ciBoardUtils"

// The menu focuses its first item, which opens a Radix tooltip; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver

const mocks = vi.hoisted(() => ({
	runCiAction: vi.fn(),
	openCiConversation: vi.fn(),
	analyzeCiItem: vi.fn(),
	runCiCustomPrompt: vi.fn(),
	requeueExpiredCiBuild: vi.fn(),
	openUrl: vi.fn(),
	openFile: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	CiBoardServiceClient: {
		runCiAction: mocks.runCiAction,
		openCiConversation: mocks.openCiConversation,
		analyzeCiItem: mocks.analyzeCiItem,
		runCiCustomPrompt: mocks.runCiCustomPrompt,
		requeueExpiredCiBuild: mocks.requeueExpiredCiBuild,
	},
	UiServiceClient: { openUrl: mocks.openUrl },
	FileServiceClient: { openFile: mocks.openFile },
}))

const action = (actionId: string, label: string, overrides: Partial<CiItemAction> = {}): CiItemAction => ({
	actionId,
	label,
	role: "menu",
	recommended: false,
	description: `${label} it.`,
	tooltip: `${label}: what it does.`,
	disabledReason: "",
	pipeline: "",
	...overrides,
})

const ACTIONS = [
	action("fix-ci", "Fix them all", { role: "primary" }),
	action("fix-conflicts", "Fix conflicts"),
	action("fix-build", "Fix build"),
	action("recalibrate", "Recalibrate"),
	action("investigate", "Investigate"),
]

const fix = (pipeline: string, overrides: Partial<CiPipelineFix> = {}): CiPipelineFix => ({
	pipeline,
	problem: "Build failed",
	category: "build",
	actionId: "fix-build",
	label: "Fix build",
	tooltip: `Fixes what breaks ${pipeline}.`,
	disabledReason: "",
	alternatives: ["recalibrate", "investigate"],
	...overrides,
})

function makeTriage(overrides: Partial<CiTriage> = {}): CiTriage {
	return {
		status: "done",
		severity: "blocker",
		summary: "The Windows build fails on a missing include.",
		source: "model",
		analyzedTs: Date.now(),
		reportPath: "",
		stale: false,
		pipelines: [
			{
				name: "win_cpu",
				category: "build",
				summary: "C2065 in mesher.cpp",
				runId: 101,
				url: "https://ci/101",
				steps: [{ job: "win", step: "Build", errors: ["e1", "e2", "e3", "e4"], excerpt: "log line" }],
			},
		],
		recommended: ["fix-ci"],
		error: "",
		conflict: false,
		...overrides,
	}
}

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
		expiredBuildPolicies: [],
		conversationId: "",
		conversationStatus: "",
		watching: false,
		runBlocked: "",
		error: "",
		actions: ACTIONS,
		fixes: [fix("win_cpu")],
		runActionId: "",
		runPipeline: "",
		...overrides,
	}
}

const row = (item: CiItem) => <CiItemRow item={item} onEditActions={vi.fn()} targetId="t1" />

describe("CiItemRow", () => {
	beforeEach(() => {
		mocks.runCiAction.mockReset().mockResolvedValue({ value: "conv-1" })
		mocks.openCiConversation.mockReset().mockResolvedValue({})
		mocks.analyzeCiItem.mockReset().mockResolvedValue({})
		mocks.runCiCustomPrompt.mockReset().mockResolvedValue({ value: "conv-2" })
		mocks.requeueExpiredCiBuild.mockReset().mockResolvedValue({})
		mocks.openUrl.mockReset().mockResolvedValue({})
		mocks.openFile.mockReset().mockResolvedValue({})
	})

	it("shows one dot per pipeline in its color, and opens a run from its dot", () => {
		render(row(makeItem()))
		const dots = screen.getByTestId("pipeline-dots").querySelectorAll("button")
		expect([...dots].map((d) => d.getAttribute("data-color"))).toEqual(["red", "green", "grey"])
		expect(dots[2]).toBeDisabled()
		fireEvent.click(dots[0])
		expect(mocks.openUrl).toHaveBeenCalledWith(expect.objectContaining({ value: "https://ci/101" }))
	})

	it("flags merge conflicts", () => {
		const { rerender } = render(row(makeItem()))
		expect(screen.queryByTestId("merge-badge")).toBeNull()
		rerender(row(makeItem({ mergeState: "conflicts" })))
		expect(screen.getByTestId("merge-badge")).toHaveTextContent("Conflicts")
	})

	it("shows expired validation separately and requeues its policy", async () => {
		const evaluationId = "12345678-1234-1234-1234-123456789abc"
		render(
			row(
				makeItem({
					pipelines: [],
					fixes: [],
					expiredBuildPolicies: [{ evaluationId, name: "PR validation", buildId: 7 }],
				}),
			),
		)
		expect(screen.getByTestId("ci-expired-badge")).toHaveTextContent("Expired")
		fireEvent.click(screen.getByLabelText("Show details"))
		expect(screen.getByTestId("ci-expired-policy")).toHaveTextContent("PR validation")
		fireEvent.click(screen.getByRole("button", { name: "Requeue" }))
		await waitFor(() => expect(mocks.requeueExpiredCiBuild).toHaveBeenCalledWith(expect.objectContaining({ evaluationId })))
	})

	it("runs the main action, and shows why when it cannot", async () => {
		const { rerender } = render(row(makeItem()))
		fireEvent.click(screen.getByTestId("ci-primary-action"))
		await waitFor(() =>
			expect(mocks.runCiAction).toHaveBeenCalledWith(
				expect.objectContaining({ targetId: "t1", itemKey: "github|github.com|octo/hello#12", actionId: "fix-ci" }),
			),
		)

		mocks.runCiAction.mockRejectedValueOnce(new Error("Could not fetch 'feature'"))
		fireEvent.click(screen.getByTestId("ci-primary-action"))
		expect(await screen.findByText("Could not fetch 'feature'")).toBeInTheDocument()

		const blocked = ACTIONS.map((a) => ({ ...a, disabledReason: "This pull request comes from a fork." }))
		rerender(row(makeItem({ actions: blocked })))
		expect(screen.getByTestId("ci-primary-action")).toBeDisabled()
	})

	it("offers the other actions, a custom prompt and a new analysis in the menu", async () => {
		render(row(makeItem({ actions: ACTIONS.map((a) => (a.actionId === "investigate" ? { ...a, recommended: true } : a)) })))
		fireEvent.click(screen.getByTestId("ci-more-actions"))
		const items = screen.getAllByRole("menuitem").map((i) => i.textContent)
		expect(items[0]).toContain("Fix conflicts")
		expect(items.some((t) => t?.includes("Investigate") && t.includes("Recommended"))).toBe(true)
		expect(items).toEqual(expect.arrayContaining([expect.stringContaining("Run a custom prompt…")]))

		fireEvent.click(screen.getByRole("menuitem", { name: /Analyze failures again/ }))
		await waitFor(() =>
			expect(mocks.analyzeCiItem).toHaveBeenCalledWith(
				expect.objectContaining({ targetId: "t1", itemKey: "github|github.com|octo/hello#12" }),
			),
		)

		fireEvent.click(screen.getByTestId("ci-more-actions"))
		fireEvent.click(screen.getByRole("menuitem", { name: /Run a custom prompt/ }))
		fireEvent.change(screen.getByLabelText("Prompt text"), { target: { value: "Explain {{prId}}" } })
		fireEvent.click(screen.getByRole("button", { name: /Run$/ }))
		await waitFor(() =>
			expect(mocks.runCiCustomPrompt).toHaveBeenCalledWith(
				expect.objectContaining({ promptKind: "text", promptValue: "Explain {{prId}}", model: "free", saveAs: "" }),
			),
		)
	})

	it("shows the triage summary and severity, and expands into the failure details", () => {
		render(row(makeItem({ triage: makeTriage({ reportPath: "/repo/.plinycode/ci-reports/pr-12-abc.md" }) })))
		expect(screen.getByTestId("severity-chip")).toHaveAttribute("data-severity", "blocker")
		expect(screen.getByTestId("ci-summary")).toHaveTextContent("The Windows build fails on a missing include.")
		expect(screen.queryByTestId("ci-item-details")).toBeNull()

		fireEvent.click(screen.getByTestId("ci-expand"))
		expect(screen.getAllByTestId("ci-pipeline-detail")[0]).toHaveTextContent("C2065 in mesher.cpp")
		expect(screen.getByText("e3")).toBeInTheDocument()
		expect(screen.queryByText("e4")).toBeNull()
		fireEvent.click(screen.getByText("Show 1 more"))
		expect(screen.getByText("e4")).toBeInTheDocument()

		fireEvent.click(screen.getByTestId("ci-open-report"))
		expect(mocks.openFile).toHaveBeenCalledWith(
			expect.objectContaining({ value: "/repo/.plinycode/ci-reports/pr-12-abc.md" }),
		)
	})

	it("says when a free model is still analysing, and has no report link without a report", () => {
		render(row(makeItem({ triage: makeTriage({ status: "pending", summary: "", pipelines: [] }) })))
		expect(screen.getByTestId("severity-pending")).toBeInTheDocument()
		expect(screen.getByTestId("ci-summary")).toHaveTextContent("Analyzing the failures with a free model…")
		fireEvent.click(screen.getByTestId("ci-expand"))
		expect(screen.queryByTestId("ci-open-report")).toBeNull()
	})

	it("expands into one line per pipeline: its problem and its own fix, then Fix them all", async () => {
		const item = makeItem({
			mergeState: "conflicts",
			pipelines: [
				{ name: "ok_cpu", color: "green", status: "completed", result: "success", runId: 1, url: "" },
				{ name: "build_cpu", color: "red", status: "completed", result: "failure", runId: 2, url: "" },
				{ name: "regress", color: "red", status: "completed", result: "failure", runId: 3, url: "" },
			],
			fixes: [
				fix("", {
					problem: "Has conflicts",
					category: "conflict",
					actionId: "fix-conflicts",
					label: "Fix conflicts",
					alternatives: [],
				}),
				fix("build_cpu"),
				fix("regress", {
					problem: "Small test delta",
					category: "small-test-delta",
					actionId: "recalibrate",
					label: "Recalibrate",
					alternatives: ["fix-build", "investigate"],
				}),
			],
		})
		render(row(item))
		fireEvent.click(screen.getByTestId("ci-expand"))
		const lines = screen.getAllByTestId("ci-pipeline-detail")
		expect(lines.map((l) => l.querySelector("[data-testid=ci-pipeline-problem]")?.textContent)).toEqual([
			"Has conflicts",
			"OK",
			"Build failed",
			"Small test delta",
		])
		expect(lines.map((l) => l.querySelector("[data-testid=ci-fix-button]")?.textContent ?? "")).toEqual([
			"Fix conflicts",
			"",
			"Fix build",
			"Recalibrate",
		])

		fireEvent.click(lines[3].querySelector("[data-testid=ci-fix-button]") as HTMLElement)
		await waitFor(() =>
			expect(mocks.runCiAction).toHaveBeenCalledWith(
				expect.objectContaining({ actionId: "recalibrate", pipeline: "regress" }),
			),
		)
		fireEvent.click(screen.getByRole("button", { name: "Other actions on build_cpu" }))
		fireEvent.click(screen.getByRole("menuitem", { name: /Investigate on build_cpu only/ }))
		await waitFor(() =>
			expect(mocks.runCiAction).toHaveBeenCalledWith(
				expect.objectContaining({ actionId: "investigate", pipeline: "build_cpu" }),
			),
		)
		fireEvent.click(lines[0].querySelector("[data-testid=ci-fix-button]") as HTMLElement)
		await waitFor(() =>
			expect(mocks.runCiAction).toHaveBeenCalledWith(expect.objectContaining({ actionId: "fix-conflicts", pipeline: "" })),
		)

		fireEvent.click(screen.getByTestId("ci-fix-all"))
		await waitFor(() =>
			expect(mocks.runCiAction).toHaveBeenLastCalledWith(expect.objectContaining({ actionId: "fix-ci", pipeline: "" })),
		)
	})

	it("disables the pipelines' fixes while a run is going, and marks the pipeline it fixes", () => {
		render(
			row(
				makeItem({
					conversationId: "conv-1",
					conversationStatus: "running",
					runActionId: "fix-build",
					runPipeline: "win_cpu",
				}),
			),
		)
		fireEvent.click(screen.getByTestId("ci-expand"))
		expect(screen.getByTestId("ci-fix-button")).toBeDisabled()
		expect(screen.getByTestId("ci-fix-all")).toBeDisabled()
		expect(screen.getAllByTestId("ci-pipeline-detail")[0]).toHaveTextContent("fixing")
	})

	it("runs a main button scoped to one pipeline on that pipeline", async () => {
		const single = ACTIONS.map((a) =>
			a.actionId === "fix-build" ? { ...a, role: "primary", pipeline: "win_cpu" } : { ...a, role: "menu" },
		)
		render(row(makeItem({ actions: single })))
		expect(screen.getByTestId("ci-primary-action")).toHaveTextContent("Fix build")
		fireEvent.click(screen.getByTestId("ci-primary-action"))
		await waitFor(() =>
			expect(mocks.runCiAction).toHaveBeenCalledWith(
				expect.objectContaining({ actionId: "fix-build", pipeline: "win_cpu" }),
			),
		)
	})

	it("shows what auto-watch is doing", () => {
		render(
			row(
				makeItem({
					auto: {
						status: "running",
						actionId: "fix-conflicts",
						attempt: 1,
						maxAttempts: 2,
						message: "Auto-watch is running Fix conflicts.",
					},
				}),
			),
		)
		expect(screen.getByTestId("ci-auto-badge")).toHaveTextContent("Auto: fixing 1/2")
	})

	it("opens the running conversation instead of starting another", () => {
		render(row(makeItem({ conversationId: "conv-1", conversationStatus: "background", watching: true })))
		fireEvent.click(screen.getByRole("button", { name: /Open conversation/ }))
		expect(mocks.openCiConversation).toHaveBeenCalledWith(
			expect.objectContaining({ value: "github|github.com|octo/hello#12" }),
		)
		expect(screen.queryByTestId("ci-primary-action")).toBeNull()
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

	it("ranks items worst first, and says how long ago", () => {
		expect(itemRank(makeItem({ triage: makeTriage() }))).toBeGreaterThan(
			itemRank(makeItem({ triage: makeTriage({ severity: "low" }) })),
		)
		expect(itemRank(makeItem({ pipelines: [] }))).toBe(0)
		expect(timeAgo(0, 3 * 60_000)).toBe("3 min ago")
		expect(timeAgo(0, 2 * 3_600_000)).toBe("2 h ago")
	})
})
