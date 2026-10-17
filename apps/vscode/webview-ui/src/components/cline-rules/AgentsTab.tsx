import { StringRequest } from "@shared/proto/cline/common"
import { AgentInfo, CreateAgentRequest, RefreshedAgents, ToggleAgentRequest } from "@shared/proto/cline/file"
import { PenIcon, PlusIcon, TriangleAlertIcon } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { FileServiceClient } from "@/services/grpc-client"

const AGENT_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

/**
 * The Rules panel's Agents tab: the configured agents (`.cline/agents/*.md`
 * and the global agents folder), each with a switch that keeps its
 * `subagent_<name>` tool away from the model, a button that opens the file,
 * and a New agent row per folder that writes a template.
 */
const AgentsTab = ({
	globalAgents,
	localAgents,
	onAgentsChanged,
}: {
	globalAgents: AgentInfo[]
	localAgents: AgentInfo[]
	onAgentsChanged: (agents: RefreshedAgents) => void
}) => {
	const toggleAgent = (agent: AgentInfo, isGlobal: boolean, enabled: boolean) => {
		FileServiceClient.toggleAgent(ToggleAgentRequest.create({ agentPath: agent.path, isGlobal, enabled }))
			.then(onAgentsChanged)
			.catch((error) => console.error("Error toggling agent:", error))
	}
	const enabledCount = [...globalAgents, ...localAgents].filter((agent) => agent.enabled && !agent.error).length
	const total = globalAgents.length + localAgents.length

	return (
		<>
			<div className="flex flex-col gap-0.5 px-2 py-2 mb-3 rounded bg-text-block-background text-xs">
				<span>
					{enabledCount} of {total} agents offered to the model
				</span>
				<span className="text-description">
					Each enabled agent adds one tool, with its description, to every request. A run costs what its model calls
					cost, like any sub-agent.
				</span>
			</div>
			<AgentSection
				agents={globalAgents}
				isGlobal={true}
				onAgentsChanged={onAgentsChanged}
				title="Global Agents"
				toggleAgent={toggleAgent}
			/>
			<AgentSection
				agents={localAgents}
				isGlobal={false}
				onAgentsChanged={onAgentsChanged}
				title="Workspace Agents"
				toggleAgent={toggleAgent}
			/>
		</>
	)
}

const AgentSection = ({
	title,
	agents,
	isGlobal,
	toggleAgent,
	onAgentsChanged,
}: {
	title: string
	agents: AgentInfo[]
	isGlobal: boolean
	toggleAgent: (agent: AgentInfo, isGlobal: boolean, enabled: boolean) => void
	onAgentsChanged: (agents: RefreshedAgents) => void
}) => (
	<div className={isGlobal ? "mb-3" : "-mb-2.5"}>
		<div className="text-sm font-normal mb-2">{title}</div>
		<div className="flex flex-col gap-0">
			{[...agents]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((agent) => (
					<AgentRow agent={agent} key={agent.path} onToggle={(enabled) => toggleAgent(agent, isGlobal, enabled)} />
				))}
			<NewAgentRow isGlobal={isGlobal} onAgentsChanged={onAgentsChanged} />
		</div>
	</div>
)

const AgentRow = ({ agent, onToggle }: { agent: AgentInfo; onToggle: (enabled: boolean) => void }) => {
	const openFile = () => {
		FileServiceClient.openFile(StringRequest.create({ value: agent.path })).catch((error) =>
			console.error("Failed to open agent file:", error),
		)
	}
	return (
		<div className="mb-2.5 px-2 py-2 rounded bg-text-block-background" data-testid="agent-row">
			<div className="flex items-center gap-2">
				<span className="flex-1 min-w-0 flex items-center gap-1.5 break-all" title={agent.path}>
					<span className="ph-no-capture font-semibold">{agent.name}</span>
					{agent.toolName && <code className="text-xs text-description">{agent.toolName}</code>}
					{agent.error && (
						<TriangleAlertIcon
							aria-label="Not loaded"
							className="shrink-0 size-[0.85rem]"
							style={{ color: "var(--vscode-editorWarning-foreground)" }}
						/>
					)}
				</span>
				<Switch
					aria-label={`${agent.enabled ? "Disable" : "Enable"} agent ${agent.name}`}
					checked={agent.enabled && !agent.error}
					disabled={!!agent.error}
					onClick={() => onToggle(!agent.enabled)}
				/>
				<Button aria-label={`Open ${agent.name}`} onClick={openFile} size="xs" title="Open agent file" variant="icon">
					<PenIcon />
				</Button>
			</div>
			{agent.error ? (
				<div className="text-xs mt-1" style={{ color: "var(--vscode-editorWarning-foreground)" }}>
					Not loaded: {agent.error}
				</div>
			) : (
				agent.description && <div className="text-xs text-description mt-1">{agent.description}</div>
			)}
			<div className="text-xs text-description mt-1 break-all">
				{agent.model ? `Model: ${agent.model} · ` : ""}
				<span className="ph-no-capture">{agent.path}</span>
			</div>
		</div>
	)
}

const NewAgentRow = ({
	isGlobal,
	onAgentsChanged,
}: {
	isGlobal: boolean
	onAgentsChanged: (agents: RefreshedAgents) => void
}) => {
	const [name, setName] = useState("")
	const [error, setError] = useState<string | null>(null)
	const inputId = isGlobal ? "new-global-agent" : "new-workspace-agent"

	const submit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		const trimmed = name.trim()
		if (!trimmed) {
			return
		}
		if (!AGENT_NAME_PATTERN.test(trimmed)) {
			setError("Agent name can only contain letters, numbers, dashes, and underscores")
			return
		}
		try {
			onAgentsChanged(await FileServiceClient.createAgentFile(CreateAgentRequest.create({ agentName: trimmed, isGlobal })))
			setName("")
			setError(null)
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to create agent")
		}
	}

	return (
		<div className="mb-2.5">
			<form className="flex items-center px-2 py-1 rounded bg-input-background" onSubmit={submit}>
				<label className="sr-only" htmlFor={inputId}>
					{isGlobal ? "New global agent name" : "New workspace agent name"}
				</label>
				<input
					className="flex-1 bg-input-background text-input-foreground border-0 outline-0 rounded focus:outline-none"
					id={inputId}
					onChange={(event) => setName(event.target.value)}
					placeholder="New agent (name, then Enter)"
					type="text"
					value={name}
				/>
				<Button aria-label="New agent" size="icon" title="New agent" type="submit" variant="icon">
					<PlusIcon />
				</Button>
			</form>
			{error && <div className="text-error text-xs mt-1 ml-2">{error}</div>}
		</div>
	)
}

export default AgentsTab
