import { EmptyRequest } from "@shared/proto/cline/common"
import { WorkspaceList } from "@shared/proto/cline/workspace"
import { workspaceRefToProto } from "@/core/workspace/workspace-identity"
import { Controller } from ".."

/**
 * The window's workspace plus the most recently used ones, newest first. The
 * recent list is read from the shared store on every call, so workspaces used
 * in other PlinyCode windows are included.
 */
export async function listRecentWorkspaces(controller: Controller, _request: EmptyRequest): Promise<WorkspaceList> {
	const [current, recent] = await Promise.all([controller.getWindowWorkspace(), controller.recentWorkspaces.list()])
	return WorkspaceList.create({
		...(current ? { current: workspaceRefToProto(current) } : {}),
		recent: recent.map(workspaceRefToProto),
	})
}
