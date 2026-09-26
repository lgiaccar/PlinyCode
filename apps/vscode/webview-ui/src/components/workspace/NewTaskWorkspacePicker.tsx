import type { WorkspaceRef } from "@shared/workspaceRef"
import { useWorkspaces } from "./useWorkspaces"
import { WorkspaceSelect, type WorkspaceSelection } from "./WorkspaceSelect"

interface NewTaskWorkspacePickerProps {
	/** The workspace the next conversation starts in; undefined means the window's. */
	value: WorkspaceRef | undefined
	onChange: (workspace: WorkspaceRef | undefined) => void
}

/**
 * Shown above the prompt box while no conversation is open: where the next
 * one runs. Defaults to the window's workspace; recent workspaces and the
 * native pickers let the user start it somewhere else.
 */
export function NewTaskWorkspacePicker({ value, onChange }: NewTaskWorkspacePickerProps) {
	const workspaces = useWorkspaces()
	const selection: WorkspaceSelection = value ? { kind: "workspace", workspace: value } : { kind: "current" }
	return (
		<div className="flex items-center gap-1 px-4 pt-2 text-xs text-description" data-testid="new-task-workspace">
			<span className="shrink-0">Start in</span>
			<WorkspaceSelect
				allowPick
				aria-label="Workspace for the new conversation"
				className="min-w-0"
				onChange={(next) => onChange(next.kind === "workspace" ? next.workspace : undefined)}
				value={selection}
				workspaces={workspaces}
			/>
		</div>
	)
}
