import type { Mode } from "@shared/storage/types"
import { workspacePathsEqual } from "@shared/workspacePath"
import type { WorkspaceRef } from "@shared/workspaceRef"
import { HostProvider } from "@/hosts/host-provider"
import type { CiRunPolicy } from "@/sdk/ci-run-policy"
import { getCiBoard } from "@/services/devops-mcp/builtin-mcp-registry"
import type { CiAutoStartResult } from "@/services/devops-mcp/ci-board/ci-auto-runner"
import type { CiRunRequest, PreparedCiRun } from "@/services/devops-mcp/ci-board/ci-board"
import type { CiModelChoice } from "@/services/devops-mcp/ci-board/types"
import { PLINY_FREE_AUTO_MODEL_ID } from "@/shared/pliny"
import { ShowMessageType } from "@/shared/proto/index.host"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"
import { sendChatButtonClickedEvent } from "../ui/subscribeToChatButtonClicked"

const START_ANYWAY = "Start anyway"

const MODE_NAMES: Record<Mode, string> = { act: "Agent", plan: "Plan", ask: "Ask" }

const modelFor = (choice: CiModelChoice) => (choice === "free" ? PLINY_FREE_AUTO_MODEL_ID : undefined)

/** A short history title: what ran, on what. */
function runTitle(run: PreparedCiRun, auto: boolean): string {
	const where = run.item.pr ? `PR #${run.item.pr.id}` : run.sourceBranch
	const scope = run.pipeline ? ` (${run.pipeline})` : ""
	return `${auto ? "CI auto-watch" : "CI board"}: ${run.action.label}${scope} on ${where}`
}

function policyFor(run: PreparedCiRun, scope: CiRunPolicy["scope"]): CiRunPolicy {
	return {
		scope,
		worktree: run.worktree.path,
		remoteName: run.remoteName,
		sourceBranch: run.sourceBranch,
		// The report folder lives in the main checkout, outside a worktree.
		readRoots: run.reportDir ? [run.reportDir] : [],
	}
}

/**
 * Starts a CI board run the user asked for: opens the item's conversation if
 * it is still running, otherwise gets a working copy for the branch and
 * starts a conversation there with the run's prompt, in the foreground.
 * Returns the conversation id, or undefined when nothing was started.
 */
export async function startCiRun(
	controller: Controller,
	targetId: string,
	itemKey: string,
	request: CiRunRequest,
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

	const run = await board.prepareRun(targetId, itemKey, request)

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

	// An action that edits and pushes runs in Agent mode; Investigate reads only, in Ask mode. The
	// run's session is built in that mode whatever the mode switch shows: flipping the switch here
	// would rebuild, and cancel the turn of, the task that is still displayed at this point.
	if (controller.stateManager.getGlobalSettingsKey("mode") !== run.mode) {
		void HostProvider.window.showMessage({
			type: ShowMessageType.INFORMATION,
			message: `"${run.action.label}" runs in ${MODE_NAMES[run.mode]} mode; the mode switch is left as it is.`,
		})
	}

	const workspace = await runWorkspace(run.worktree.path, run.worktree.inPlace)
	const modelId = modelFor(run.action.model)
	const conversationId = await controller.initTask(run.prompt, [], [], undefined, undefined, workspace, {
		recordRecentWorkspace: false,
		modelId,
		title: runTitle(run, false),
		mode: run.mode,
	})
	if (!conversationId) {
		return undefined
	}
	controller.setCiRunPolicy(conversationId, policyFor(run, "guard"))
	await board.setLink(itemKey, {
		conversationId,
		actionId: run.action.id,
		worktree: run.worktree.path,
		headSha: run.item.headSha,
		startedTs: Date.now(),
		modelId,
		sourceBranch: run.sourceBranch,
		remoteName: run.remoteName,
		pipeline: run.pipeline,
	})
	await sendChatButtonClickedEvent()
	Logger.log(`[CiBoard] Started ${run.action.id} for ${itemKey} in ${run.worktree.path}: ${conversationId}`)
	return conversationId
}

/**
 * Starts an auto-watch run: in the background, on the free model, with the
 * unattended approval policy. The displayed task and the mode switch are left
 * alone.
 */
export async function startCiAutoRun(
	controller: Controller,
	targetId: string,
	itemKey: string,
	actionId: string,
): Promise<CiAutoStartResult> {
	const board = getCiBoard()
	if (!board) {
		return { error: "The CI board is not available." }
	}
	if (controller.backgroundFreeSlots <= 1) {
		return "full"
	}
	const run = await board.prepareRun(targetId, itemKey, { actionId }, { auto: true })
	if (run.worktree.inPlace) {
		// Never edit the user's own checkout unattended: it may hold their uncommitted work.
		return {
			error: `${run.sourceBranch} is checked out in your own folder, so auto-watch will not change it. Switch that folder to another branch, or run the action yourself.`,
		}
	}
	const workspace: WorkspaceRef = { path: run.worktree.path, kind: "folder", folders: [run.worktree.path] }
	const started = await controller.startBackgroundTask(run.prompt, workspace, {
		recordRecentWorkspace: false,
		// Background runs skip the spending check, so they always run on the free model.
		modelId: PLINY_FREE_AUTO_MODEL_ID,
		mode: run.mode,
		title: runTitle(run, true),
	})
	if (started.status === "full") {
		return "full"
	}
	if (started.status === "error") {
		return { error: started.message }
	}
	controller.setCiRunPolicy(started.conversationId, policyFor(run, "auto"))
	await board.setLink(itemKey, {
		conversationId: started.conversationId,
		actionId: run.action.id,
		worktree: run.worktree.path,
		headSha: run.item.headSha,
		startedTs: Date.now(),
		auto: true,
		modelId: PLINY_FREE_AUTO_MODEL_ID,
		sourceBranch: run.sourceBranch,
		remoteName: run.remoteName,
	})
	Logger.log(`[CiBoard] Auto-watch started ${run.action.id} for ${itemKey}: ${started.conversationId}`)
	return "started"
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
