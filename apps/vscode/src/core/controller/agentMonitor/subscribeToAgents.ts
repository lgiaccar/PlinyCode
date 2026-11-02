import { AgentMonitorState } from "@shared/proto/cline/agent_monitor"
import type { EmptyRequest } from "@shared/proto/cline/common"
import { AgentMonitorHost } from "@/services/devops-mcp/host/AgentMonitorHost"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

export async function subscribeToAgents(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<AgentMonitorState>,
	requestId?: string,
): Promise<void> {
	const monitor = AgentMonitorHost.current?.monitor
	if (!monitor) {
		await responseStream(
			AgentMonitorState.create({ error: "Agent monitor is still starting. Reopen Pipelines in a moment." }),
			false,
		)
		return
	}
	let unsubscribe = () => {}
	const send = () => responseStream(AgentMonitorState.create(monitor.view()), false).catch(() => unsubscribe())
	unsubscribe = monitor.onDidChange(() => void send())
	if (requestId)
		getRequestRegistry().registerRequest(requestId, unsubscribe, { type: "agent_monitor_subscription" }, responseStream)
	await send()
}
