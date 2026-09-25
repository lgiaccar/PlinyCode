import type { EmptyRequest } from "@shared/proto/cline/common"
import type { DevOpsServerStatus } from "@shared/proto/cline/mcp"
import { getDevOpsServerControl } from "@/services/devops-mcp/builtin-mcp-registry"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"
import { toProtoDevOpsStatus, UNAVAILABLE_DEVOPS_STATUS } from "./devops-server-status"

/** Streams the built-in DevOps server's status to the MCP Servers view. */
export async function subscribeToDevOpsServer(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<DevOpsServerStatus>,
	requestId?: string,
): Promise<void> {
	const control = getDevOpsServerControl()
	if (!control) {
		await responseStream(UNAVAILABLE_DEVOPS_STATUS, false)
		return
	}
	const send = (status: typeof control.status) =>
		responseStream(toProtoDevOpsStatus(status), false).catch((error) => {
			Logger.error("Error sending DevOps server status:", error)
			subscription.dispose()
		})
	const subscription = control.onDidChangeStatus((status) => void send(status))
	if (requestId) {
		getRequestRegistry().registerRequest(
			requestId,
			() => subscription.dispose(),
			{ type: "devOpsServer_subscription" },
			responseStream,
		)
	}
	await send(control.status)
}
