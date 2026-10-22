import type { TaskWorktree } from "@shared/HistoryItem"
import { StringRequest } from "@shared/proto/cline/common"
import { WorktreeActionRequest } from "@shared/proto/cline/task"
import { CopyIcon, ExternalLinkIcon, GitBranchIcon, GitMergeIcon, GitPullRequestIcon, Trash2Icon } from "lucide-react"
import type React from "react"
import { TaskServiceClient } from "@/services/grpc-client"

type WorktreeAction = "apply" | "create_pr" | "remove"

/**
 * Task-header line for a conversation started with "Run in worktree"
 * (docs/task-worktrees.md): the branch it works on, and buttons that open the
 * worktree in a new VS Code window, apply its changes to the source checkout,
 * open a pull request, and remove it. The extension asks in a modal before
 * each action.
 */
const TaskWorktreeChip: React.FC<{ taskId?: string; worktree?: TaskWorktree }> = ({ taskId, worktree }) => {
	if (!taskId || !worktree) {
		return null
	}
	// The header toggles on click; these buttons only act on the worktree.
	const openInNewWindow = (event: React.MouseEvent) => {
		event.stopPropagation()
		TaskServiceClient.openTaskWorktree(StringRequest.create({ value: taskId })).catch((error) =>
			console.error("Failed to open the worktree:", error),
		)
	}
	const run = (action: WorktreeAction) => (event: React.MouseEvent) => {
		event.stopPropagation()
		TaskServiceClient.worktreeAction(WorktreeActionRequest.create({ taskId, action })).catch((error) =>
			console.error(`Worktree action ${action} failed:`, error),
		)
	}
	const button = (label: string, title: string, onClick: (event: React.MouseEvent) => void, icon: React.ReactNode) => (
		<button
			aria-label={label}
			className="shrink-0 flex items-center p-0.5 border-0 bg-transparent text-description hover:text-foreground cursor-pointer"
			onClick={onClick}
			onKeyDown={(event) => event.stopPropagation()}
			title={title}
			type="button">
			{icon}
		</button>
	)
	const removed = !!worktree.removedTs
	const copyPath = (event: React.MouseEvent) => {
		event.stopPropagation()
		navigator.clipboard.writeText(worktree.path).catch((error) => console.error("Failed to copy the worktree path:", error))
	}
	return (
		<div
			className="flex items-center justify-center gap-1 w-full min-w-0 text-xs text-description select-text"
			data-testid="task-worktree-chip"
			title={
				removed
					? `The worktree ${worktree.path} was removed; the conversation continues in ${worktree.repoRoot}`
					: `Worktree ${worktree.path}, branched from ${worktree.repoRoot}`
			}>
			<GitBranchIcon className="shrink-0" size={11} />
			<span className="shrink-0">Worktree</span>
			<code className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" title={worktree.branch}>
				{worktree.branch}
			</code>
			<span aria-hidden="true">·</span>
			{removed ? (
				<code className="min-w-0 break-all text-left" title={worktree.path}>
					{worktree.path}
				</code>
			) : (
				<button
					aria-label={`Open worktree at ${worktree.path}`}
					className="min-w-0 break-all text-left text-link bg-transparent border-0 p-0 cursor-pointer select-text"
					onClick={openInNewWindow}
					onKeyDown={(event) => event.stopPropagation()}
					title={worktree.path}
					type="button">
					{worktree.path}
				</button>
			)}
			{button("Copy worktree path", `Copy ${worktree.path}`, copyPath, <CopyIcon size={11} />)}
			{removed ? (
				<span className="shrink-0">(removed)</span>
			) : (
				<>
					{button(
						"Open the worktree in a new window",
						"Open in new window",
						openInNewWindow,
						<ExternalLinkIcon size={11} />,
					)}
					{button(
						`Apply the worktree's changes to ${worktree.repoRoot}`,
						`Apply to ${worktree.repoRoot}: stage the worktree's changes there`,
						run("apply"),
						<GitMergeIcon size={11} />,
					)}
					{button(
						"Create a pull request from the worktree branch",
						"Create PR: commit, push and open a draft pull request",
						run("create_pr"),
						<GitPullRequestIcon size={11} />,
					)}
					{button("Remove the worktree", "Remove worktree", run("remove"), <Trash2Icon size={11} />)}
				</>
			)}
		</div>
	)
}

export default TaskWorktreeChip
