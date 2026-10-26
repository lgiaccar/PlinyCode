import type { ChangeEvent } from "react"
import type { AgentStateEntry } from "@shared/ExtensionMessage"

interface AgentPickerProps {
	/** All enabled custom agents (global + workspace combined) */
	agents: AgentStateEntry[]
	/** Currently selected agent path, or undefined for the generic agent */
	value: string | undefined
	onChange: (agentPath: string | undefined) => void
}

/**
 * A compact inline selector for the custom agent to use on the next task.
 * Only rendered in agent (act) mode when at least one enabled agent exists.
 * Choosing "Generic" (the default) means no custom agent is used.
 */
export function AgentPicker({ agents, value, onChange }: AgentPickerProps) {
	const enabledAgents = agents.filter((a) => a.enabled && !a.error)
	if (enabledAgents.length === 0) {
		return null
	}

	const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
		onChange(e.target.value || undefined)
	}

	return (
		<div className="flex items-center gap-1.5 px-2 pt-1 pb-0.5" data-testid="agent-picker">
			<span className="text-xs text-description shrink-0">Agent:</span>
			<select
				aria-label="Select agent"
				className="text-xs bg-input-background text-input-foreground border border-input-border rounded px-1 py-0.5 outline-none focus:outline-none cursor-pointer flex-1 min-w-0"
				onChange={handleChange}
				value={value ?? ""}>
				<option value="">Generic</option>
				{enabledAgents.map((agent) => (
					<option key={agent.path} title={agent.description} value={agent.path}>
						{agent.name}
						{agent.model ? ` · ${agent.model}` : ""}
					</option>
				))}
			</select>
		</div>
	)
}
