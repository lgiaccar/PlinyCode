import { ChevronDown } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import styled from "styled-components"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpc-client"

interface ConversationAgentPickerProps {
	// For new tasks (before first message): local state that gets passed to newTask
	selectedAgentPath?: string | undefined
	onSelectedAgentPathChange?: (agentPath: string | undefined) => void
}

const DropdownContainer = styled.div`
	position: relative;
	display: inline-flex;
	min-width: 0;
	max-width: 100%;
`

const TriggerButton = styled.button`
	padding: 0 2px;
	height: 20px;
	min-width: 0;
	cursor: pointer;
	text-decoration: none;
	color: var(--vscode-descriptionForeground);
	display: flex;
	align-items: center;
	gap: 2px;
	font-size: 10px;
	outline: none;
	user-select: none;
	background: none;
	border: none;

	&:hover,
	&:focus {
		color: var(--vscode-foreground);
		text-decoration: underline;
		outline: none;
	}
`

const TriggerLabel = styled.span`
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
`

const MenuContainer = styled.div`
	position: absolute;
	bottom: calc(100% + 4px);
	left: 0;
	width: min(280px, calc(100vw - 16px));
	z-index: 1000;
`

const DropdownMenu = styled.div`
	max-height: 280px;
	overflow-y: auto;
	background: var(--vscode-dropdown-background);
	border: 1px solid var(--vscode-dropdown-border);
	border-radius: 3px;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
`

const MenuItem = styled.button<{ isSelected: boolean }>`
	width: 100%;
	padding: 6px 10px;
	background: ${(p) => (p.isSelected ? "var(--vscode-list-activeSelectionBackground)" : "transparent")};
	color: ${(p) => (p.isSelected ? "var(--vscode-list-activeSelectionForeground)" : "var(--vscode-foreground)")};
	border: none;
	text-align: left;
	cursor: pointer;
	font-size: 11px;
	display: flex;
	flex-direction: column;
	gap: 2px;

	&:hover {
		background: ${(p) =>
			p.isSelected ? "var(--vscode-list-activeSelectionBackground)" : "var(--vscode-list-hoverBackground)"};
	}
`

const AgentName = styled.div`
	font-weight: 500;
`

const AgentMeta = styled.div`
	font-size: 10px;
	color: var(--vscode-descriptionForeground);
	display: flex;
	gap: 8px;
`

export const ConversationAgentPicker: React.FC<ConversationAgentPickerProps> = ({
	selectedAgentPath: propsAgentPath,
	onSelectedAgentPathChange,
}) => {
	const { globalAgents, localAgents, currentTaskItem } = useExtensionState()
	const [isOpen, setIsOpen] = useState(false)
	const containerRef = useRef<HTMLDivElement>(null)

	// Determine mode: new task (no currentTaskItem) vs existing task
	const isNewTask = !currentTaskItem

	// Current agent path: from props for new tasks (or as fallback until the history
	// item arrives from the extension), from history item for existing tasks.
	const currentAgentPath = isNewTask
		? propsAgentPath
		: (currentTaskItem?.agentPath ?? propsAgentPath)

	// All enabled agents
	const allAgents = [...(globalAgents ?? []), ...(localAgents ?? [])]
	const enabledAgents = allAgents.filter((a) => a.enabled && !a.error)

	// Current agent entry (or null for Generic)
	const currentAgent = currentAgentPath ? enabledAgents.find((a) => a.path === currentAgentPath) : null

	// Close on outside click
	useEffect(() => {
		if (!isOpen) return
		const handler = (e: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setIsOpen(false)
			}
		}
		document.addEventListener("mousedown", handler)
		return () => document.removeEventListener("mousedown", handler)
	}, [isOpen])

	const handleSelect = (agentPath: string | undefined) => {
		if (isNewTask) {
			// Before first message: update local state (will be passed to newTask)
			onSelectedAgentPathChange?.(agentPath)
		} else {
			// After first message: call RPC to update the session
			TaskServiceClient.updateAgentPath({
				metadata: {},
				agentPath: agentPath ?? "",
			})
		}
		setIsOpen(false)
	}

	// Don't render if no agents exist
	if (enabledAgents.length === 0) {
		return null
	}

	return (
		<DropdownContainer ref={containerRef}>
			<TriggerButton
				aria-label="Select agent"
				data-testid="agent-picker-trigger"
				onClick={() => setIsOpen(!isOpen)}
				type="button">
				<TriggerLabel>{currentAgent ? currentAgent.name : "Generic Agent"}</TriggerLabel>
				<ChevronDown size={10} />
			</TriggerButton>

			{isOpen && (
				<MenuContainer>
					<DropdownMenu role="listbox">
						<MenuItem
							isSelected={!currentAgentPath}
							onClick={() => handleSelect(undefined)}
							role="option"
							type="button">
							<AgentName>Generic Agent</AgentName>
							<AgentMeta>Default instructions</AgentMeta>
						</MenuItem>

						{enabledAgents.map((agent) => (
							<MenuItem
								isSelected={agent.path === currentAgentPath}
								key={agent.path}
								onClick={() => handleSelect(agent.path)}
								role="option"
								type="button">
								<AgentName>{agent.name}</AgentName>
								<AgentMeta>
									{agent.description && <span>{agent.description}</span>}
									{agent.model && <span>· {agent.model}</span>}
								</AgentMeta>
							</MenuItem>
						))}
					</DropdownMenu>
				</MenuContainer>
			)}
		</DropdownContainer>
	)
}
