import { Empty } from "@shared/proto/cline/common"
import { UpdateAgentPathRequest } from "@shared/proto/cline/task"
import { Controller } from ".."

/**
 * Updates the agent path for the current conversation, allowing mid-conversation agent switching.
 * The new agent takes effect on the next session rebuild (e.g., next user message, mode change).
 */
export async function updateAgentPath(controller: Controller, request: UpdateAgentPathRequest): Promise<Empty> {
	const agentPath = request.agentPath || undefined
	await controller.updateAgentPath(agentPath)
	return Empty.create()
}
