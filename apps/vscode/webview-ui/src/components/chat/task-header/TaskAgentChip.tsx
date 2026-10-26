import { BotIcon } from "lucide-react"

/**
 * Task-header chip for conversations started with a custom agent selected in
 * the new-task UI. Shows the agent file's stem name (e.g. "code-reviewer"
 * for ".cursor/agents/code-reviewer.md") with a bot icon. Read-only — the
 * agent is fixed at task start and cannot be changed mid-conversation.
 */
const TaskAgentChip: React.FC<{ agentPath?: string }> = ({ agentPath }) => {
	if (!agentPath) {
		return null
	}
	// Extract the file stem: take the last path segment, then strip the extension.
	const fileName = agentPath.replace(/.*[\\/]/, "")
	const agentName = fileName.replace(/\.[^.]+$/, "") || fileName

	return (
		<div
			className="flex items-center gap-1 w-full min-w-0 text-xs text-description select-text"
			data-testid="task-agent-chip"
			title={`Running as agent: ${agentPath}`}>
			<BotIcon className="shrink-0" size={11} />
			<span className="shrink-0">Agent:</span>
			<code className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{agentName}</code>
		</div>
	)
}

export default TaskAgentChip
