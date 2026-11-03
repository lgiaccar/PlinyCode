import type { CiItem, CiTargetView } from "@shared/proto/cline/ci_board"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CiTargetSection } from "./CiTargetSection"

const mocks = vi.hoisted(() => ({
	updateCiTarget: vi.fn(),
	removeCiTarget: vi.fn(),
	refreshCiBoard: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	CiBoardServiceClient: {
		updateCiTarget: mocks.updateCiTarget,
		removeCiTarget: mocks.removeCiTarget,
		refreshCiBoard: mocks.refreshCiBoard,
		pickCiPromptFile: vi.fn(),
	},
	UiServiceClient: { openUrl: vi.fn() },
	FileServiceClient: { openFile: vi.fn() },
}))

const item = (key: string, overrides: Partial<CiItem> = {}): CiItem => ({
	key,
	prId: 1,
	title: key,
	url: "",
	sourceBranch: key,
	targetBranch: "main",
	author: "",
	draft: false,
	state: "open",
	headSha: "",
	mergeState: "clean",
	pipelines: [{ name: "ci", color: "green", status: "completed", result: "success", runId: 1, url: "" }],
	expiredBuildPolicies: [],
	provider: "github",
	buildPolicies: [],
	conversationId: "",
	conversationStatus: "",
	watching: false,
	runBlocked: "",
	error: "",
	actions: [],
	fixes: [],
	runActionId: "",
	runPipeline: "",
	...overrides,
})

const builtin = (id: string, label: string, auto: boolean) => ({
	id,
	label,
	promptKind: "builtin",
	promptValue: id,
	model: "free",
	situation: "any",
	auto,
	builtin: true,
})

function makeTarget(overrides: Partial<CiTargetView> = {}): CiTargetView {
	return {
		id: "t1",
		kind: "repo",
		label: "octo/hello: my open PRs",
		remoteUrl: "https://github.com/octo/hello",
		provider: "github",
		checkout: "/repo",
		branch: "",
		prId: 0,
		prFilter: "mine",
		actions: [
			builtin("fix-conflicts", "Fix conflicts", true),
			builtin("recalibrate", "Recalibrate", true),
			builtin("fix-ci", "Fix them all", false),
			builtin("investigate", "Investigate", false),
		],
		items: [
			item("green"),
			item("broken", {
				pipelines: [{ name: "ci", color: "red", status: "completed", result: "failure", runId: 2, url: "" }],
				triage: {
					status: "done",
					severity: "blocker",
					summary: "",
					source: "model",
					analyzedTs: 0,
					reportPath: "",
					stale: false,
					pipelines: [],
					recommended: [],
					error: "",
					conflict: false,
				},
			}),
		],
		error: "",
		loading: false,
		autoWatch: false,
		skills: [{ actionId: "fix-conflicts", name: "fix-conflicts", path: "/repo/.github/skills/fix-conflicts/SKILL.md" }],
		...overrides,
	}
}

describe("CiTargetSection", () => {
	beforeEach(() => {
		mocks.updateCiTarget.mockReset().mockResolvedValue({})
		mocks.removeCiTarget.mockReset().mockResolvedValue({})
	})

	it("lists failing items first, and only them when asked", () => {
		const { rerender } = render(<CiTargetSection target={makeTarget()} />)
		expect(screen.getAllByTestId("ci-item").map((el) => el.textContent)).toEqual([
			expect.stringContaining("broken"),
			expect.stringContaining("green"),
		])
		rerender(<CiTargetSection failingOnly target={makeTarget()} />)
		expect(screen.getAllByTestId("ci-item")).toHaveLength(1)
	})

	it("turns auto-watch on", async () => {
		render(<CiTargetSection target={makeTarget()} />)
		fireEvent.click(screen.getByTestId("ci-auto-watch"))
		await waitFor(() =>
			expect(mocks.updateCiTarget).toHaveBeenCalledWith(expect.objectContaining({ id: "t1", autoWatch: true })),
		)
	})

	it("asks before removing an entry", async () => {
		render(<CiTargetSection target={makeTarget()} />)
		fireEvent.click(screen.getByRole("button", { name: "Remove from the board" }))
		expect(mocks.removeCiTarget).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "Remove" }))
		await waitFor(() => expect(mocks.removeCiTarget).toHaveBeenCalled())
	})

	it("edits the actions: auto-watch permission, the repository's skill, and a new action of its own", async () => {
		render(<CiTargetSection target={makeTarget()} />)
		fireEvent.click(screen.getByRole("button", { name: "Edit actions" }))
		expect(screen.getByText("Follows this repository's /fix-conflicts skill.")).toBeInTheDocument()
		expect(screen.getByText(/No recalibration skill found/)).toBeInTheDocument()
		fireEvent.click(screen.getByLabelText("Auto-watch may run Recalibrate"))
		fireEvent.click(screen.getByRole("button", { name: /Add action/ }))
		fireEvent.change(screen.getByLabelText("Prompt file"), { target: { value: "AI_prompts/x.md" } })
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		await waitFor(() => expect(mocks.updateCiTarget).toHaveBeenCalled())
		const request = mocks.updateCiTarget.mock.calls[0][0]
		expect(request.setActions).toBe(true)
		expect(request.actions.find((a: { id: string }) => a.id === "recalibrate").auto).toBe(false)
		expect(request.actions.at(-1)).toMatchObject({ promptKind: "file", promptValue: "AI_prompts/x.md", builtin: false })
	})
})
