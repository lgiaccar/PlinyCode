import { Empty, StringRequest } from "@shared/proto/cline/common"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { isDirectory } from "@/utils/fs"
import { Controller } from ".."

/**
 * Opens the git worktree of a conversation started with "Run in worktree" in a
 * new VS Code window (docs/task-worktrees.md). Only a worktree recorded on the
 * conversation can be opened this way; a missing one is reported to the user.
 */
export async function openTaskWorktree(controller: Controller, request: StringRequest): Promise<Empty> {
	const taskId = request.value?.trim()
	const worktree = taskId ? await controller.getTaskWorktree(taskId) : undefined
	if (!worktree) {
		return Empty.create({})
	}
	if (!(await isDirectory(worktree.path))) {
		await HostProvider.window
			.showMessage({
				type: ShowMessageType.ERROR,
				message: `The worktree ${worktree.path} no longer exists.`,
			})
			.catch(() => undefined)
		return Empty.create({})
	}
	await HostProvider.workspace.openFolderInNewWindow({ path: worktree.path })
	return Empty.create({})
}
