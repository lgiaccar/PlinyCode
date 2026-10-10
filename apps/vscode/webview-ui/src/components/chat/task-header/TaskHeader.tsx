import { ClineContextBreakdown, ClineMessage } from "@shared/ExtensionMessage"
import { isPlinyFreeModelId } from "@shared/pliny"
import { RenameTaskRequest, SetTaskSpendingLimitRequest } from "@shared/proto/cline/task"
import { historyItemWorkspaceDisplayPath, workspacePathLabel } from "@shared/workspacePath"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import React, { useCallback, useMemo, useState } from "react"
import { canRestoreWorkspaceFromMessage, getRestoreWorkspaceDisabledReason } from "@/components/chat/chat-view/utils/messageUtils"
import UserMessage from "@/components/chat/UserMessage"
import PlinyBudgetIndicator from "@/components/common/PlinyBudgetIndicator"
import TaskTitleInput from "@/components/history/TaskTitleInput"
import { getModeSpecificFields } from "@/components/settings/utils/providerUtils"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useNormalizedApiConfiguration } from "@/hooks/useNormalizedApiConfiguration"
import { useProviderUsageCostDisplay } from "@/hooks/useProviderUsageCostDisplay"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"
import { getEnvironmentColor } from "@/utils/environmentColors"
import { formatStartTime } from "@/utils/format"
import { autoCompactThresholdFor } from "./autoCompactThreshold"
import CopyTaskButton from "./buttons/CopyTaskButton"
import DeleteTaskButton from "./buttons/DeleteTaskButton"
import ExportMarkdownButton from "./buttons/ExportMarkdownButton"
import NewTaskButton from "./buttons/NewTaskButton"
import OpenDiskConversationHistoryButton from "./buttons/OpenDiskConversationHistoryButton"
import RenameTaskButton from "./buttons/RenameTaskButton"
import ContextWindow from "./ContextWindow"
import { highlightText } from "./Highlights"
import TaskUsageCounter from "./TaskUsageCounter"
import TaskWorkingDirectoryBadge from "./TaskWorkingDirectoryBadge"

const IS_DEV = process.env.IS_DEV === "true"
interface TaskHeaderProps {
	clineMessages: ClineMessage[]
	task: ClineMessage
	tokensIn: number
	tokensOut: number
	doesModelSupportPromptCache: boolean
	cacheWrites?: number
	cacheReads?: number
	totalCost: number
	lastApiReqTotalTokens?: number
	/** True when any request contributing to the totals above used a char-based estimate rather than provider-reported usage. */
	hasEstimatedUsage?: boolean
	contextBreakdown?: ClineContextBreakdown
	onClose: () => void
	onSendMessage?: (command: string, files: string[], images: string[]) => void
}

const BUTTON_CLASS = "max-h-3 border-0 font-bold bg-transparent hover:opacity-100 text-foreground"

const TaskHeader: React.FC<TaskHeaderProps> = ({
	clineMessages,
	task,
	tokensIn,
	tokensOut,
	cacheWrites,
	cacheReads,
	totalCost,
	lastApiReqTotalTokens,
	hasEstimatedUsage,
	contextBreakdown,
	onClose,
	onSendMessage,
}) => {
	const {
		apiConfiguration,
		currentTaskItem,
		mode,
		expandTaskHeader: isTaskExpanded,
		setExpandTaskHeader: setIsTaskExpanded,
		environment,
		workspaceRoots,
		primaryRootIndex,
		platform,
		conversationSpendingLimit,
	} = useExtensionState()

	const [isRenaming, setIsRenaming] = useState(false)
	const renamedTitle = currentTaskItem?.isRenamed ? currentTaskItem.task : undefined
	const titleText = renamedTitle ?? task.text
	const highlightedText = useMemo(() => highlightText(titleText, false), [titleText])

	// Workspace the conversation belongs to, shown under the title. Prefers the
	// folder recorded on the task, falling back to the open primary root.
	const workspacePath =
		(currentTaskItem && historyItemWorkspaceDisplayPath(currentTaskItem)) ||
		workspaceRoots?.[primaryRootIndex ?? 0]?.path ||
		""
	const workspaceLabel = workspacePath ? workspacePathLabel(workspacePath, platform) : undefined

	const renameTask = useCallback(
		(title: string) => {
			const taskId = currentTaskItem?.id
			if (!taskId) {
				return
			}
			TaskServiceClient.renameTask(RenameTaskRequest.create({ taskId, title })).catch((err) =>
				console.error("Failed to rename task:", err),
			)
		},
		[currentTaskItem?.id],
	)

	const setBudget = useCallback(
		(limit: number) => {
			const taskId = currentTaskItem?.id
			if (!taskId) {
				return
			}
			TaskServiceClient.setTaskSpendingLimit(SetTaskSpendingLimitRequest.create({ taskId, limit })).catch((err) =>
				console.error("Failed to set the conversation budget:", err),
			)
		},
		[currentTaskItem?.id],
	)

	// Simplified computed values
	const { selectedModelId, selectedModelInfo } = useNormalizedApiConfiguration(mode)
	const modeFields = getModeSpecificFields(apiConfiguration, mode)

	// The SDK is the source of truth for whether to render per-task cost:
	// any `metadata.usageCostDisplay` other than "show" suppresses it. This
	// mirrors the CLI's `shouldShowCliUsageCost` consumer.
	const usageCostDisplay = useProviderUsageCostDisplay(modeFields.apiProvider)
	const isCostAvailable = usageCostDisplay === "show"

	// The conversation's own budget, else the default for new conversations.
	// Free models are never limited, so no budget is shown while one is selected.
	const budget = isPlinyFreeModelId(selectedModelId)
		? undefined
		: (currentTaskItem?.spendingLimit ?? conversationSpendingLimit ?? 5)

	// Event handlers
	const toggleTaskExpanded = useCallback(() => setIsTaskExpanded(!isTaskExpanded), [setIsTaskExpanded, isTaskExpanded])

	const environmentBorderColor = getEnvironmentColor(environment, "border")

	return (
		<div className="py-2 px-4 flex flex-col gap-2">
			{/* Task Header */}
			<div
				className={cn(
					"relative overflow-hidden cursor-pointer rounded-sm flex flex-col gap-1.5 z-10 pt-2 pb-2 px-2 hover:opacity-100 bg-(--vscode-toolbar-hoverBackground)/65",
					{
						"opacity-100 border-1": isTaskExpanded, // No hover effects when expanded, add border
						"hover:bg-toolbar-hover border-1": !isTaskExpanded, // Hover effects only when collapsed
					},
				)}
				style={{
					borderColor: environmentBorderColor,
				}}>
				{/* Task Title */}
				<div
					aria-label={isTaskExpanded ? "Collapse task header" : "Expand task header"}
					className="flex justify-between items-center cursor-pointer"
					onClick={toggleTaskExpanded}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault()
							e.stopPropagation()
							toggleTaskExpanded()
						}
					}}>
					<div className="flex justify-between items-center">
						{isTaskExpanded ? <ChevronDownIcon size="16" /> : <ChevronRightIcon size="16" />}
						{isTaskExpanded && (
							<div className="mt-1 flex justify-end cursor-pointer opacity-80 gap-2 mx-2">
								<CopyTaskButton className={BUTTON_CLASS} taskText={task.text} />
								<DeleteTaskButton
									className={BUTTON_CLASS}
									taskId={currentTaskItem?.id}
									taskSize={currentTaskItem?.size}
								/>
								{/* Only visible in development mode */}
								{IS_DEV && (
									<OpenDiskConversationHistoryButton className={BUTTON_CLASS} taskId={currentTaskItem?.id} />
								)}
							</div>
						)}
					</div>
					{/* Conversation title, with the workspace name underneath, centred between the button groups */}
					<div className="flex flex-col items-center justify-center select-none grow min-w-0 px-2 text-center">
						{isRenaming ? (
							<TaskTitleInput
								initialTitle={titleText ?? ""}
								onCommit={renameTask}
								onDone={() => setIsRenaming(false)}
							/>
						) : (
							<div className="whitespace-nowrap overflow-hidden text-ellipsis w-full min-w-0" title={titleText}>
								<span className="ph-no-capture text-base">{isTaskExpanded ? titleText : highlightedText}</span>
							</div>
						)}
						{workspaceLabel && (
							<div
								className="whitespace-nowrap overflow-hidden text-ellipsis w-full min-w-0 text-xs text-description"
								title={workspacePath}>
								{workspaceLabel}
							</div>
						)}
					</div>
					<div className="inline-flex items-center justify-end select-none shrink-0">
						<TaskUsageCounter
							activeMs={currentTaskItem?.activeMs}
							budget={budget}
							cacheReads={cacheReads}
							cacheWrites={cacheWrites}
							hasEstimatedUsage={hasEstimatedUsage}
							onBudgetChange={currentTaskItem?.id ? setBudget : undefined}
							runningSinceTs={currentTaskItem?.runningSinceTs}
							startedTs={currentTaskItem?.startedTs}
							tokensIn={tokensIn}
							tokensOut={tokensOut}
							totalCost={isCostAvailable ? (totalCost ?? 0) : undefined}
						/>
						<TaskWorkingDirectoryBadge
							platform={platform}
							taskCwd={currentTaskItem?.cwdOnTaskInitialization}
							workspaceRoots={workspaceRoots}
						/>
						{currentTaskItem?.id && <RenameTaskButton className={BUTTON_CLASS} onClick={() => setIsRenaming(true)} />}
						<ExportMarkdownButton className={BUTTON_CLASS} taskId={currentTaskItem?.id} />
						<NewTaskButton className={BUTTON_CLASS} onClick={onClose} />
					</div>
				</div>

				{/* Expand/Collapse Task Details */}
				{isTaskExpanded && (
					<div className="flex flex-col break-words" key={`task-details-${currentTaskItem?.id}`}>
						<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
							{currentTaskItem?.startedTs ? (
								<div className="text-xs text-description">
									Started {formatStartTime(currentTaskItem.startedTs)}
								</div>
							) : null}
							<PlinyBudgetIndicator refreshKey={Math.floor(totalCost ?? 0)} />
						</div>
						<div className="mt-1">
							<UserMessage
								canRestoreWorkspace={canRestoreWorkspaceFromMessage(clineMessages, task.ts)}
								files={task.files}
								images={task.images}
								messageTs={task.ts}
								restoreWorkspaceDisabledReason={getRestoreWorkspaceDisabledReason(clineMessages, task.ts)}
								text={task.text}
							/>
						</div>

						<ContextWindow
							autoCompactThreshold={autoCompactThresholdFor(selectedModelInfo)}
							cacheReads={cacheReads}
							cacheWrites={cacheWrites}
							contextBreakdown={contextBreakdown}
							contextWindow={selectedModelInfo?.contextWindow}
							hasEstimatedUsage={hasEstimatedUsage}
							lastApiReqTotalTokens={lastApiReqTotalTokens}
							onSendMessage={onSendMessage}
							tokensIn={tokensIn}
							tokensOut={tokensOut}
							useAutoCondense={false} // Disable auto-condense configuration in UI for now
						/>
					</div>
				)}
			</div>
		</div>
	)
}

export default TaskHeader
