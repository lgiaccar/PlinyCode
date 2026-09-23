import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"

/**
 * Shows that a task is still running in the background (after the user
 * started or opened another task), or that it is waiting for the user.
 */
export const BackgroundTaskBadge = ({ taskId, className }: { taskId: string; className?: string }) => {
	const { backgroundTasks } = useExtensionState()
	const backgroundTask = backgroundTasks?.find((task) => task.id === taskId)
	if (!backgroundTask) {
		return null
	}

	const needsAttention = backgroundTask.status === "needs_attention"
	const label = needsAttention ? "Needs approval" : "Running"
	const title = needsAttention
		? "Running in the background and waiting for you. Open it to respond."
		: "Still running in the background. Open it to follow along."
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 text-xs rounded px-1.5 py-0.5 flex-shrink-0",
				needsAttention ? "bg-button-background text-button-foreground" : "bg-accent/20 text-description",
				className,
			)}
			data-testid="background-task-badge"
			title={title}>
			<span
				aria-hidden="true"
				className={cn(
					"codicon text-[11px]",
					needsAttention ? "codicon-bell-dot" : "codicon-loading codicon-modifier-spin",
				)}
			/>
			{label}
		</span>
	)
}
