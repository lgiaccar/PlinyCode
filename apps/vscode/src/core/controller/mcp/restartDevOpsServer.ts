import type { EmptyRequest } from "@shared/proto/cline/common"
import type { DevOpsServerStatus } from "@shared/proto/cline/mcp"
import { getDevOpsServerControl } from "@/services/devops-mcp/builtin-mcp-registry"
import type { Controller } from "../index"
import { toProtoDevOpsStatus, UNAVAILABLE_DEVOPS_STATUS } from "./devops-server-status"

export async function restartDevOpsServer(_controller: Controller, _request: EmptyRequest): Promise<DevOpsServerStatus> {
	const control = getDevOpsServerControl()
	if (!control) {
		return UNAVAILABLE_DEVOPS_STATUS
	}
	await control.restart()
	return toProtoDevOpsStatus(control.status)
}
