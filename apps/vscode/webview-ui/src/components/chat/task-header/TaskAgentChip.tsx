import { UserIcon } from "lucide-react"
import type React from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"

/**
 * Task-header chip that displays the active custom agent name when a
 * conversation is using a custom agent instead of the generic agent.
 * When the agent has a description, it is shown below the name in a
 * muted / light-gray style so the user can confirm which agent is active.
 */
const TaskAgentChip: React.FC<{ agentPath?: string }> = ({ agentPath }) => {
	const { globalAgents, localAgents } = useExtensionState()

	if (!agentPath) {
		return null
	}

	// Find the agent by path in either global or local agents
	const allAgents = [...(globalAgents ?? []), ...(localAgents ?? [])]
	const agent = allAgents.find((a) => a.path === agentPath)

	// If we can't find the agent (e.g., it was deleted), show the path
	const displayName =
		agent?.name ??
		agentPath
			.split("/")
			.pop()
			?.replace(/\.(md|yml|yaml)$/, "") ??
		"Unknown Agent"

	const description = agent?.description

	return (
		<div
			className="flex items-center justify-center gap-1 text-xs text-description select-text shrink-0"
			data-testid="task-agent-chip">
			<UserIcon className="shrink-0" size={11} />
			<span className="shrink-0">Agent:</span>
			<code
				className="overflow-hidden text-ellipsis whitespace-nowrap"
				title={[displayName, description].filter(Boolean).join(" — ")}>
				{displayName}
			</code>
		</div>
	)
}

export default TaskAgentChip
