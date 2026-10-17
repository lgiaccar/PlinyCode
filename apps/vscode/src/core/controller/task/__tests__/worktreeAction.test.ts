import os from "node:os"
import path from "node:path"
import type { Controller } from "@core/controller"
import type { HistoryItem } from "@shared/HistoryItem"
import { WorktreeActionRequest } from "@shared/proto/cline/task"
import { ShowMessageType } from "@shared/proto/host/window"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { worktreeAction } from "../worktreeAction"

const showMessage = vi.hoisted(() => vi.fn())

vi.mock("@/hosts/host-provider", () => ({ HostProvider: { window: { showMessage } } }))
vi.mock("@/services/devops-mcp/builtin-mcp-registry", () => ({
	waitForCiWatchRepoOpener: vi.fn(async () => {
		throw new Error("The PlinyCode DevOps service has not started, so CI cannot be read.")
	}),
}))

const gone = path.join(os.tmpdir(), "plinycode-no-such-repo")
const worktree = { repoRoot: gone, branch: "plinycode/fix-ab12", path: path.join(`${gone}.worktrees`, "fix-ab12") }
const item: HistoryItem = { id: "task-1", task: "Fix it", ts: 1, tokensIn: 0, tokensOut: 0, totalCost: 0, worktree }

function fakeController(activity: "running" | "background" | "idle" = "idle") {
	return {
		task: { taskId: "task-1" },
		getHistoryItem: vi.fn(async () => item),
		conversationActivity: vi.fn(() => activity),
		emitInfoRow: vi.fn(),
		setTaskWorktree: vi.fn(async () => undefined),
		reinitExistingTaskFromId: vi.fn(async () => undefined),
	}
}

const request = (action: string) => WorktreeActionRequest.create({ taskId: "task-1", action })

describe("worktreeAction", () => {
	beforeEach(() => {
		showMessage.mockReset().mockResolvedValue({})
	})

	it("ignores an unknown action", async () => {
		const controller = fakeController()
		await worktreeAction(controller as unknown as Controller, request("merge"))
		expect(controller.getHistoryItem).not.toHaveBeenCalled()
		expect(showMessage).not.toHaveBeenCalled()
	})

	it("shows a refusal as an error message without asking", async () => {
		const controller = fakeController("background")
		await worktreeAction(controller as unknown as Controller, request("remove"))
		expect(showMessage).toHaveBeenCalledOnce()
		expect(showMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: ShowMessageType.ERROR, message: expect.stringContaining("still running") }),
		)
	})

	it("asks in a modal, then forgets a vanished worktree and moves the conversation on screen out of it", async () => {
		showMessage.mockResolvedValue({ selectedOption: "Remove" })
		const controller = fakeController()

		await worktreeAction(controller as unknown as Controller, request("remove"))

		expect(showMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: ShowMessageType.WARNING,
				message: expect.stringContaining("already gone"),
				options: expect.objectContaining({ modal: true, items: ["Remove"] }),
			}),
		)
		expect(controller.setTaskWorktree).toHaveBeenCalledWith("task-1", { ...worktree, removedTs: expect.any(Number) })
		expect(controller.reinitExistingTaskFromId).toHaveBeenCalledWith("task-1")
		expect(controller.emitInfoRow).toHaveBeenCalledWith("task-1", expect.stringContaining("Removed the worktree"))
	})

	it("does nothing when the modal is dismissed", async () => {
		showMessage.mockResolvedValue({})
		const controller = fakeController()
		await worktreeAction(controller as unknown as Controller, request("remove"))
		expect(controller.setTaskWorktree).not.toHaveBeenCalled()
	})

	it("reports that the DevOps server is not available for Create PR", async () => {
		const controller = fakeController()
		await worktreeAction(controller as unknown as Controller, request("create_pr"))
		// The worktree folder is gone, so it stops before reaching the DevOps server.
		expect(showMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: ShowMessageType.ERROR, message: expect.stringContaining("no longer exists") }),
		)
	})
})
