import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import TaskWorktreeChip from "./TaskWorktreeChip"

const openTaskWorktree = vi.fn().mockResolvedValue({})

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		openTaskWorktree: (request: unknown) => openTaskWorktree(request),
	},
}))

const worktree = { repoRoot: "/repo", branch: "plinycode/fix-login-ab12", path: "/repo.worktrees/fix-login-ab12" }

describe("TaskWorktreeChip", () => {
	it("shows the branch and opens the worktree in a new window without toggling the header", () => {
		const onHeaderClick = vi.fn()
		render(
			// biome-ignore lint/a11y/useKeyWithClickEvents: stands in for the task header's clickable title row
			<div onClick={onHeaderClick}>
				<TaskWorktreeChip taskId="task-1" worktree={worktree} />
			</div>,
		)

		expect(screen.getByTestId("task-worktree-chip").textContent).toContain("Worktreeplinycode/fix-login-ab12")
		fireEvent.click(screen.getByLabelText("Open the worktree in a new window"))
		expect(openTaskWorktree).toHaveBeenCalledWith(expect.objectContaining({ value: "task-1" }))
		expect(onHeaderClick).not.toHaveBeenCalled()
	})

	it("renders nothing for a conversation without a worktree", () => {
		const { container } = render(<TaskWorktreeChip taskId="task-1" />)
		expect(container.innerHTML).toBe("")
	})
})
