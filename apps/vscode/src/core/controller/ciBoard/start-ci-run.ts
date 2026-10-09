import { workspacePathsEqual } from "@shared/workspacePath"
import type { WorkspaceRef } from "@shared/workspaceRef"
import { HostProvider } from "@/hosts/host-provider"
import { getCiBoard } from "@/services/devops-mcp/builtin-mcp-registry"
import { ShowMessageType } from "@/shared/proto/index.host"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"
import { sendChatButtonClickedEvent } from "../ui/subscribeToChatButtonClicked"

const START_ANYWAY = "Start anyway"

/**
 * Starts a CI board action: opens the item's conversation if it is still
 * running, otherwise gets a working copy for the branch and starts a new
 * conversation there with the action's prompt. Returns the conversation id,
 * or undefined when nothing was started.
 */
export async function startCiRun(
	controller: Controller,
	targetId: string,
	itemKey: string,
	actionId: string,
): Promise<string | undefined> {
	const board = getCiBoard()
	if (!board) {
		throw new Error("The CI board is not available.")
	}
	const link = board.linkFor(itemKey)
	if (link && controller.conversationActivity(link.conversationId) !== "idle") {
		await controller.showTaskWithId(link.conversationId)
		await sendChatButtonClickedEvent()
		return link.conversationId
	}

	const run = await board.prepareRun(targetId, itemKey, actionId)

	if (controller.startWouldStopRunningTask) {
		const { selectedOption } = await HostProvider.window.showMessage({
			type: ShowMessageType.WARNING,
			message:
				"A task is running and the background already holds the most tasks it can. Starting this CI run stops the running task.",
			options: { modal: true, items: [START_ANYWAY] },
		})
		if (selectedOption !== START_ANYWAY) {
			return undefined
		}
	}

	// An action edits and pushes, which plan and ask modes forbid. The run's
	// session is built in act mode whatever the mode switch shows: flipping the
	// switch here would rebuild, and cancel the turn of, the task that is still
	// displayed at this point.
	if (controller.stateManager.getGlobalSettingsKey("mode") !== "act") {
		void HostProvider.window.showMessage({
			type: ShowMessageType.INFORMATION,
			message: "The CI action runs in Agent mode; the mode switch is left as it is.",
		})
	}

	const workspace = await runWorkspace(run.worktree.path, run.worktree.inPlace)
	const conversationId = await controller.initTask(run.prompt, [], [], undefined, undefined, workspace, {
		recordRecentWorkspace: false,
		mode: "act",
	})
	if (!conversationId) {
		return undefined
	}
	await board.setLink(itemKey, {
		conversationId,
		actionId: run.action.id,
		worktree: run.worktree.path,
		headSha: run.item.headSha,
		startedTs: Date.now(),
	})
	await sendChatButtonClickedEvent()
	Logger.log(`[CiBoard] Started ${run.action.id} for ${itemKey} in ${run.worktree.path}: ${conversationId}`)
	return conversationId
}

/**
 * The workspace to bind the run to: none (the window's own) when it runs in
 * the window's folder, otherwise the worktree as a folder workspace.
 */
async function runWorkspace(folder: string, inPlace: boolean): Promise<WorkspaceRef | undefined> {
	if (inPlace) {
		const { paths } = await HostProvider.workspace.getWorkspacePaths({})
		if (workspacePathsEqual(paths?.[0], folder)) {
			return undefined
		}
	}
	return { path: folder, kind: "folder", folders: [folder] }
}
