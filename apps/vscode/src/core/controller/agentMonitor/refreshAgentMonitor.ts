import { Empty, type StringRequest } from "@shared/proto/cline/common"
import { AgentMonitorHost } from "@/services/devops-mcp/host/AgentMonitorHost"
import type { Controller } from "../index"

export async function refreshAgentMonitor(_controller: Controller, request: StringRequest): Promise<Empty> {
	const monitor = AgentMonitorHost.current?.monitor
	if (!monitor) throw new Error("Agent monitor is still starting. Reopen Pipelines in a moment.")
	await monitor.refresh(request.value)
	return Empty.create({})
}
