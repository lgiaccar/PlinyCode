import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import TaskWorktreeChip from "./TaskWorktreeChip"

const openTaskWorktree = vi.fn().mockResolvedValue({})
const worktreeAction = vi.fn().mockResolvedValue({})

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		openTaskWorktree: (request: unknown) => openTaskWorktree(request),
		worktreeAction: (request: unknown) => worktreeAction(request),
	},
}))

const worktree = { repoRoot: "/repo", branch: "plinycode/fix-login-ab12", path: "/repo.worktrees/fix-login-ab12" }

describe("TaskWorktreeChip", () => {
	beforeEach(() => {
		openTaskWorktree.mockClear()
		worktreeAction.mockClear()
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: vi.fn().mockResolvedValue(undefined) },
		})
	})

	it("shows the branch and opens the worktree in a new window without toggling the header", () => {
		const onHeaderClick = vi.fn()
		render(
			// biome-ignore lint/a11y/useKeyWithClickEvents: stands in for the task header's clickable title row
			<div onClick={onHeaderClick}>
				<TaskWorktreeChip taskId="task-1" worktree={worktree} />
			</div>,
		)

		expect(screen.getByTestId("task-worktree-chip").textContent).toContain(worktree.path)
		fireEvent.click(screen.getByLabelText(`Open worktree at ${worktree.path}`))
		fireEvent.click(screen.getByLabelText("Copy worktree path"))
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith(worktree.path)
		fireEvent.click(screen.getByLabelText("Open the worktree in a new window"))
		expect(openTaskWorktree).toHaveBeenCalledWith(expect.objectContaining({ value: "task-1" }))
		expect(onHeaderClick).not.toHaveBeenCalled()
	})

	it("sends the apply, pull request and remove actions for the conversation", () => {
		const onHeaderClick = vi.fn()
		render(
			// biome-ignore lint/a11y/useKeyWithClickEvents: stands in for the task header's clickable title row
			<div onClick={onHeaderClick}>
				<TaskWorktreeChip taskId="task-1" worktree={worktree} />
			</div>,
		)

		fireEvent.click(screen.getByLabelText("Apply the worktree's changes to /repo"))
		fireEvent.click(screen.getByLabelText("Create a pull request from the worktree branch"))
		fireEvent.click(screen.getByLabelText("Remove the worktree"))

		expect(worktreeAction.mock.calls.map(([request]) => request)).toEqual([
			expect.objectContaining({ taskId: "task-1", action: "apply" }),
			expect.objectContaining({ taskId: "task-1", action: "create_pr" }),
			expect.objectContaining({ taskId: "task-1", action: "remove" }),
		])
		expect(onHeaderClick).not.toHaveBeenCalled()
	})

	it("marks a removed worktree and retains its copyable path", () => {
		render(<TaskWorktreeChip taskId="task-1" worktree={{ ...worktree, removedTs: 5 }} />)
		expect(screen.getByTestId("task-worktree-chip").textContent).toContain("(removed)")
		expect(screen.getByTestId("task-worktree-chip").textContent).toContain(worktree.path)
		expect(screen.queryByLabelText(`Open worktree at ${worktree.path}`)).toBeNull()
		expect(screen.getByLabelText("Copy worktree path")).toBeInTheDocument()
	})

	it("renders nothing for a conversation without a worktree", () => {
		const { container } = render(<TaskWorktreeChip taskId="task-1" />)
		expect(container.innerHTML).toBe("")
	})
})
