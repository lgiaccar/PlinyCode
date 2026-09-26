import { PickWorkspaceRequest, Workspace } from "@shared/proto/cline/workspace"
import { CODE_WORKSPACE_EXTENSION } from "@shared/workspaceRef"
import { resolveWorkspaceRef, workspaceRefToProto } from "@/core/workspace/workspace-identity"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Lets the user pick a folder or a `.code-workspace` file to start a
 * conversation in. The choice is resolved to a workspace identity (a file with
 * one folder becomes that folder) and recorded as recently used. Returns an
 * empty path when the dialog was cancelled or the file could not be read.
 */
export async function pickWorkspace(controller: Controller, request: PickWorkspaceRequest): Promise<Workspace> {
	const pickFile = request.kind === "workspaceFile"
	const { paths } = await HostProvider.window.showOpenDialogue({
		canSelectMany: false,
		openLabel: pickFile ? "Use workspace" : "Use folder",
		...(pickFile
			? { filters: { files: [CODE_WORKSPACE_EXTENSION.slice(1)] } }
			: { canSelectFolders: true, canSelectFiles: false }),
	})
	const picked = paths?.[0]?.trim()
	if (!picked) {
		return Workspace.create({})
	}
	try {
		const workspace = await resolveWorkspaceRef(picked)
		if (workspace.folders.length === 0) {
			throw new Error(`${picked} lists no folders`)
		}
		await controller.recentWorkspaces.touch(workspace)
		return workspaceRefToProto(workspace)
	} catch (error) {
		Logger.warn("[pickWorkspace] Cannot use the picked workspace:", error)
		HostProvider.window
			.showMessage({
				type: ShowMessageType.ERROR,
				message: `PlinyCode cannot use ${picked} as a workspace: ${error instanceof Error ? error.message : String(error)}`,
			})
			.catch(() => undefined)
		return Workspace.create({})
	}
}
