import { RefreshedAgents, ToggleAgentRequest } from "@shared/proto/cline/file"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."
import { buildRefreshedAgents } from "./refreshAgents"

/**
 * Switches a configured agent on or off. A switched-off agent's
 * `subagent_<name>` tool is left out of the next session's tools
 * (configured-agents.ts, buildDisabledAgentToolPolicies).
 */
export async function toggleAgent(controller: Controller, request: ToggleAgentRequest): Promise<RefreshedAgents> {
	const { agentPath, isGlobal, enabled } = request
	if (!agentPath || typeof enabled !== "boolean" || typeof isGlobal !== "boolean") {
		Logger.error("toggleAgent: Missing or invalid parameters", { agentPath, isGlobal, enabled })
		throw new Error("Missing or invalid parameters for toggleAgent")
	}

	if (isGlobal) {
		const toggles = controller.stateManager.getGlobalSettingsKey("globalAgentToggles") ?? {}
		controller.stateManager.setGlobalState("globalAgentToggles", { ...toggles, [agentPath]: enabled })
	} else {
		const toggles = controller.stateManager.getWorkspaceStateKey("localAgentToggles") ?? {}
		controller.stateManager.setWorkspaceState("localAgentToggles", { ...toggles, [agentPath]: enabled })
	}

	return buildRefreshedAgents(controller)
}
