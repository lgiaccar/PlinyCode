import { type ConfiguredAgentEntry, listConfiguredAgents, resolveAgentLocations } from "@core/context/instructions/user-instructions/configured-agents"
import { readAgentFileLocations } from "@/hosts/vscode/agent-file-locations"
import { EmptyRequest } from "@shared/proto/cline/common"
import { AgentInfo, RefreshedAgents } from "@shared/proto/cline/file"
import { HostProvider } from "@/hosts/host-provider"
import type { Controller } from ".."

function toAgentInfo(agent: ConfiguredAgentEntry): AgentInfo {
	return AgentInfo.create({
		name: agent.name,
		description: agent.description,
		path: agent.path,
		enabled: agent.enabled,
		model: agent.model,
		toolName: agent.toolName,
		error: agent.error ?? "",
	})
}

/** The configured agents of the primary workspace folder and the global agents folder, split by scope. */
export async function buildRefreshedAgents(controller: Controller): Promise<RefreshedAgents> {
	const workspacePaths = await HostProvider.workspace.getWorkspacePaths({})
	const primaryWorkspace = workspacePaths.paths[0]
	const extraPaths = readAgentFileLocations(primaryWorkspace)
	const locations = resolveAgentLocations(primaryWorkspace, extraPaths)
	const agents = listConfiguredAgents(primaryWorkspace, controller.stateManager, locations)
	return RefreshedAgents.create({
		globalAgents: agents.filter((agent) => agent.scope === "global").map(toAgentInfo),
		localAgents: agents.filter((agent) => agent.scope === "workspace").map(toAgentInfo),
	})
}

/** Lists the configured agents for the Agents tab of the Rules panel. */
export async function refreshAgents(controller: Controller, _request: EmptyRequest): Promise<RefreshedAgents> {
	return buildRefreshedAgents(controller)
}


