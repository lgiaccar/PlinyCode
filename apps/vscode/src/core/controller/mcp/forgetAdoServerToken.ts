import type { StringRequest } from "@shared/proto/cline/common"
import type { DevOpsServerStatus } from "@shared/proto/cline/mcp"
import { getDevOpsServerControl } from "@/services/devops-mcp/builtin-mcp-registry"
import type { Controller } from "../index"
import { toProtoDevOpsStatus, UNAVAILABLE_DEVOPS_STATUS } from "./devops-server-status"

/** Removes the personal access token stored for the Azure DevOps Server host `request.value`. */
export async function forgetAdoServerToken(_controller: Controller, request: StringRequest): Promise<DevOpsServerStatus> {
	const control = getDevOpsServerControl()
	if (!control) {
		return UNAVAILABLE_DEVOPS_STATUS
	}
	await control.forgetAdoServerToken(request.value)
	return toProtoDevOpsStatus(control.status)
}
