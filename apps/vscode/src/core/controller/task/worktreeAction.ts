import { Empty } from "@shared/proto/cline/common"
import type { WorktreeActionRequest } from "@shared/proto/cline/task"
import { HostProvider } from "@/hosts/host-provider"
import { waitForCiWatchRepoOpener } from "@/services/devops-mcp/builtin-mcp-registry"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Controller } from ".."
import { isWorktreeActionKind, runWorktreeAction, type WorktreeActionDeps } from "./worktree-action-runner"

/** How long Create PR waits for the DevOps service, which starts after the controller. */
const DEVOPS_WAIT_MS = 10_000

/** The editor and controller behind the worktree actions. */
function worktreeActionDeps(controller: Controller): WorktreeActionDeps {
	return {
		getHistoryItem: (taskId) => controller.getHistoryItem(taskId),
		isRunning: (taskId) => controller.conversationActivity(taskId) !== "idle",
		confirm: async (message, detail, items) =>
			(
				await HostProvider.window.showMessage({
					type: ShowMessageType.WARNING,
					message,
					options: { modal: true, detail, items },
				})
			).selectedOption,
		showError: async (message) => {
			await HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message }).catch(() => undefined)
		},
		emitRow: (taskId, text) => controller.emitInfoRow(taskId, text),
		setWorktree: (taskId, worktree) => controller.setTaskWorktree(taskId, worktree),
		afterRemoved: async (taskId) => {
			// The conversation on screen still has the removed folder as its cwd; resuming moves it out.
			if (controller.task?.taskId === taskId) {
				await controller.reinitExistingTaskFromId(taskId)
			}
		},
		openRepo: async (cwd) => (await waitForCiWatchRepoOpener(DEVOPS_WAIT_MS))(cwd),
	}
}

/**
 * Apply, Create PR or Remove worktree for a "Run in worktree" conversation
 * (docs/task-worktrees.md). Each asks in a modal first; refusals are shown as
 * error messages and change nothing.
 */
export async function worktreeAction(controller: Controller, request: WorktreeActionRequest): Promise<Empty> {
	const taskId = request.taskId?.trim()
	if (taskId && isWorktreeActionKind(request.action)) {
		await runWorktreeAction(worktreeActionDeps(controller), taskId, request.action)
	}
	return Empty.create({})
}
