import type { AgentMonitorSettings } from "@shared/proto/cline/agent_monitor"
import { Empty } from "@shared/proto/cline/common"
import { AgentMonitorHost } from "@/services/devops-mcp/host/AgentMonitorHost"
import type { Controller } from "../index"

export async function configureAgentMonitor(_controller: Controller, request: AgentMonitorSettings): Promise<Empty> {
	const host = AgentMonitorHost.current
	if (!host) throw new Error("Agent monitor is still starting. Reopen Pipelines in a moment.")
	if (request.authentication !== "windows" && request.authentication !== "pat")
		throw new Error("Invalid authentication choice.")
	host.configure({ ...request, authentication: request.authentication })
	return Empty.create({})
}
