import type { TaskWorktree } from "@shared/HistoryItem"
import { StringRequest } from "@shared/proto/cline/common"
import { ExternalLinkIcon, GitBranchIcon } from "lucide-react"
import type React from "react"
import { TaskServiceClient } from "@/services/grpc-client"

/**
 * Task-header line for a conversation started with "Run in worktree"
 * (docs/task-worktrees.md): the branch it works on, and a button that opens
 * the worktree in a new VS Code window.
 */
const TaskWorktreeChip: React.FC<{ taskId?: string; worktree?: TaskWorktree }> = ({ taskId, worktree }) => {
	if (!taskId || !worktree) {
		return null
	}
	const openInNewWindow = (event: React.MouseEvent) => {
		// The header toggles on click; this button only opens the worktree.
		event.stopPropagation()
		TaskServiceClient.openTaskWorktree(StringRequest.create({ value: taskId })).catch((error) =>
			console.error("Failed to open the worktree:", error),
		)
	}
	return (
		<div
			className="flex items-center justify-center gap-1 w-full min-w-0 text-xs text-description"
			data-testid="task-worktree-chip"
			title={`Worktree ${worktree.path}, branched from ${worktree.repoRoot}`}>
			<GitBranchIcon className="shrink-0" size={11} />
			<span className="shrink-0">Worktree</span>
			<code className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{worktree.branch}</code>
			<button
				aria-label="Open the worktree in a new window"
				className="shrink-0 flex items-center p-0.5 border-0 bg-transparent text-description hover:text-foreground cursor-pointer"
				onClick={openInNewWindow}
				onKeyDown={(event) => event.stopPropagation()}
				title="Open in new window"
				type="button">
				<ExternalLinkIcon size={11} />
			</button>
		</div>
	)
}

export default TaskWorktreeChip
