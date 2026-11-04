import { AgentMonitorsState } from "@shared/proto/cline/agent_monitor"
import type { EmptyRequest } from "@shared/proto/cline/common"
import { AgentMonitorHost } from "@/services/devops-mcp/host/AgentMonitorHost"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

export async function subscribeToAgents(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<AgentMonitorsState>,
	requestId?: string,
): Promise<void> {
	const monitor = AgentMonitorHost.current?.monitor
	if (!monitor) {
		await responseStream(
			AgentMonitorsState.create({ error: "Agent monitor is still starting. Reopen Pipelines in a moment." }),
			false,
		)
		return
	}
	let unsubscribe = () => {}
	const send = () =>
		responseStream(
			AgentMonitorsState.create({
				...monitor.view(),
				defaultAuthentication: process.platform === "win32" ? "windows" : "pat",
			}),
			false,
		).catch(() => unsubscribe())
	unsubscribe = monitor.onDidChange(() => void send())
	if (requestId)
		getRequestRegistry().registerRequest(requestId, unsubscribe, { type: "agent_monitor_subscription" }, responseStream)
	await send()
}
