import { Empty, type StringRequest } from "@shared/proto/cline/common"
import { AgentMonitorHost } from "@/services/devops-mcp/host/AgentMonitorHost"
import type { Controller } from "../index"

export async function removeAgentMonitor(_controller: Controller, request: StringRequest): Promise<Empty> {
	const host = AgentMonitorHost.current
	if (!host) throw new Error("Agent monitor is still starting. Reopen Pipelines in a moment.")
	host.remove(request.value)
	return Empty.create({})
}
