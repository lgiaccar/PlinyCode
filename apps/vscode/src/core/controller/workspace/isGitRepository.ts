import { BooleanResponse, StringRequest } from "@shared/proto/cline/common"
import { resolveWorkspaceRef } from "@/core/workspace/workspace-identity"
import { isInGitRepository } from "@/services/git/worktrees"
import { Controller } from ".."

/**
 * Whether a conversation started in a workspace can run in a git worktree: the
 * workspace's first folder, where the conversation would run, is in a git
 * repository. An empty path asks about the window's workspace; an empty window
 * or an unreadable workspace answers false. The webview shows "Run in worktree"
 * only when this is true (docs/task-worktrees.md).
 */
export async function isGitRepository(controller: Controller, request: StringRequest): Promise<BooleanResponse> {
	const requested = request.value?.trim()
	try {
		const workspace = requested ? await resolveWorkspaceRef(requested) : await controller.getWindowWorkspace()
		const folder = workspace?.folders.find((entry) => entry.trim().length > 0)
		return BooleanResponse.create({ value: folder ? await isInGitRepository(folder) : false })
	} catch {
		return BooleanResponse.create({ value: false })
	}
}
