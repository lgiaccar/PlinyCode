import { StringRequest } from "@shared/proto/cline/common"
import type { WorkspaceRef } from "@shared/workspaceRef"
import { useEffect, useState } from "react"
import { WorkspaceServiceClient } from "@/services/grpc-client"
import { useWorkspaces } from "./useWorkspaces"
import { WorkspaceSelect, type WorkspaceSelection } from "./WorkspaceSelect"

interface NewTaskWorkspacePickerProps {
	/** The workspace the next conversation starts in; undefined means the window's. */
	value: WorkspaceRef | undefined
	onChange: (workspace: WorkspaceRef | undefined) => void
	/** Whether the next conversation runs in a git worktree of its own ("Run in worktree"). */
	worktree?: boolean
	/** Without it, the "Run in worktree" checkbox is not offered. */
	onWorktreeChange?: (worktree: boolean) => void
}

/**
 * Whether the workspace at `workspacePath` ("" for the window's) is a git
 * repository; undefined while the extension is asked, or when `workspacePath`
 * is undefined.
 */
function useIsGitRepository(workspacePath: string | undefined): boolean | undefined {
	const [answer, setAnswer] = useState<{ path: string; value: boolean } | undefined>(undefined)
	useEffect(() => {
		if (workspacePath === undefined) {
			return
		}
		let cancelled = false
		WorkspaceServiceClient.isGitRepository(StringRequest.create({ value: workspacePath }))
			.then((response) => {
				if (!cancelled) setAnswer({ path: workspacePath, value: response.value === true })
			})
			.catch(() => {
				if (!cancelled) setAnswer({ path: workspacePath, value: false })
			})
		return () => {
			cancelled = true
		}
	}, [workspacePath])
	return answer && answer.path === workspacePath ? answer.value : undefined
}

/**
 * Shown above the prompt box while no conversation is open: where the next
 * one runs. Defaults to the window's workspace; recent workspaces and the
 * native pickers let the user start it somewhere else. When that workspace is
 * a git repository, "Run in worktree" starts the conversation on a new branch
 * in a worktree of its own (docs/task-worktrees.md).
 */
export function NewTaskWorkspacePicker({ value, onChange, worktree = false, onWorktreeChange }: NewTaskWorkspacePickerProps) {
	const workspaces = useWorkspaces()
	const selection: WorkspaceSelection = value ? { kind: "workspace", workspace: value } : { kind: "current" }
	const isGitRepository = useIsGitRepository(onWorktreeChange ? (value?.path ?? "") : undefined)

	// A workspace that is not a repository cannot run in a worktree: drop a choice made for another one.
	useEffect(() => {
		if (isGitRepository === false && worktree) {
			onWorktreeChange?.(false)
		}
	}, [isGitRepository, worktree, onWorktreeChange])

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
			{onWorktreeChange && isGitRepository && (
				<label
					className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap"
					title="Start the conversation on a new git branch, in a worktree next to the repository, so its edits stay out of your checkout.">
					<input
						checked={worktree}
						className="m-0 cursor-pointer"
						data-testid="new-task-worktree"
						onChange={(event) => onWorktreeChange(event.target.checked)}
						type="checkbox"
					/>
					Run in worktree
				</label>
			)}
		</div>
	)
}
