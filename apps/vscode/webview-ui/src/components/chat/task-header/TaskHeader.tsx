import { conversationRef } from "@shared/conversationRef"
import { ClineContextBreakdown, ClineMessage } from "@shared/ExtensionMessage"
import { applyTunedInputBudget, modelTuningFor } from "@shared/model-tuning"
import { isPlinyFreeModelId } from "@shared/pliny"
import { RenameTaskRequest, SetTaskSpendingLimitRequest } from "@shared/proto/cline/task"
import { withRouterCompactionBudget } from "@shared/router-tuning"
import { historyItemWorkspaceDisplayPath, workspacePathLabel } from "@shared/workspacePath"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import React, { useCallback, useMemo, useState } from "react"
import { canRestoreWorkspaceFromMessage, getRestoreWorkspaceDisabledReason } from "@/components/chat/chat-view/utils/messageUtils"
import UserMessage from "@/components/chat/UserMessage"
import PlinyBudgetIndicator from "@/components/common/PlinyBudgetIndicator"
import TaskTitleInput from "@/components/history/TaskTitleInput"
import { getModeSpecificFields } from "@/components/settings/utils/providerUtils"
import { updateSetting } from "@/components/settings/utils/settingsHandlers"
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
import TaskAgentChip from "./TaskAgentChip"
import TaskUsageCounter from "./TaskUsageCounter"
import { TaskWaitLimit } from "./TaskWaitLimit"
import TaskWorkingDirectoryBadge from "./TaskWorkingDirectoryBadge"
import TaskWorktreeChip from "./TaskWorktreeChip"
import TokenUsagePanel from "./TokenUsagePanel"

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
	/** Tokens the last request left out before it was sent (old tool output, earlier reasoning). */
	prunedTokens?: number
	onClose: () => void
	onSendMessage?: (command: string, files: string[], images: string[]) => void
}

// The header sits above the chat, so its prompt starts shorter than the chat's.
const TASK_HEADER_PROMPT_MAX_HEIGHT = 160

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
	prunedTokens,
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
		maxWaitMinutesPerTurn,
		useAutoCondense,
		compactionThreshold,
		modelTuning,
		routerTuning,
	} = useExtensionState()
	const setCompactionThreshold = useCallback((threshold: number) => updateSetting("compactionThreshold", threshold), [])

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
	const { selectedModelId, selectedModelInfo: catalogModelInfo } = useNormalizedApiConfiguration(mode)
	// The context bar budgets against the tuned prompt budget, as compaction does:
	// a router's Settings → Router budget, then the model tuning's smaller context.
	const selectedModelInfo = useMemo(() => {
		const routerInfo = withRouterCompactionBudget(catalogModelInfo, selectedModelId, routerTuning) ?? catalogModelInfo
		return (
			applyTunedInputBudget(
				{ [selectedModelId]: routerInfo },
				selectedModelId,
				modelTuningFor(modelTuning, selectedModelId),
			)?.[selectedModelId] ?? routerInfo
		)
	}, [catalogModelInfo, modelTuning, routerTuning, selectedModelId])
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
		<div className="py-2 px-4 max-h-[50%] shrink-0 overflow-y-auto">
			{/* Task Header */}
			<div
				className={cn(
					"relative overflow-hidden rounded-sm flex flex-col gap-1.5 z-10 pt-2 pb-2 px-2 hover:opacity-100 bg-(--vscode-toolbar-hoverBackground)/65",
					{
						"opacity-100 border-1": isTaskExpanded, // No hover effects when expanded, add border
						"hover:bg-toolbar-hover border-1": !isTaskExpanded, // Hover effects only when collapsed
					},
				)}
				style={{
					borderColor: environmentBorderColor,
				}}>
				<div className="flex items-start gap-2">
					<div className="min-w-0 flex-1">
						{isRenaming ? (
							<TaskTitleInput
								initialTitle={titleText ?? ""}
								onCommit={renameTask}
								onDone={() => setIsRenaming(false)}
							/>
						) : (
							<div className="truncate text-sm font-medium" title={titleText}>
								<span className="ph-no-capture">{highlightedText}</span>
							</div>
						)}
						<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-description">
							{workspaceLabel && (
								<span className="min-w-0 truncate" title={workspacePath}>
									{workspaceLabel}
								</span>
							)}
							{currentTaskItem?.runningSinceTs !== undefined && <span>Running</span>}
							{!currentTaskItem?.worktree && (
								<TaskWorkingDirectoryBadge
									platform={platform}
									taskCwd={currentTaskItem?.cwdOnTaskInitialization}
									workspaceRoots={workspaceRoots}
								/>
							)}
						</div>
						<TaskWorktreeChip taskId={currentTaskItem?.id} worktree={currentTaskItem?.worktree} />
					</div>
					<NewTaskButton className={BUTTON_CLASS} onClick={onClose} />
				</div>
				<button
					aria-controls="task-header-details"
					aria-expanded={isTaskExpanded}
					aria-label={isTaskExpanded ? "Collapse task header" : "Expand task header"}
					className="flex w-fit items-center gap-1 border-0 bg-transparent p-0 text-xs text-description cursor-pointer hover:text-foreground"
					onClick={toggleTaskExpanded}
					type="button">
					{isTaskExpanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
					Details
				</button>

				{/* Expand/Collapse Task Details */}
				<PlinyBudgetIndicator refreshKey={Math.floor(totalCost ?? 0)} />
				{isTaskExpanded && (
					<div
						className="flex flex-col break-words"
						id="task-header-details"
						key={`task-details-${currentTaskItem?.id}`}>
						<div aria-label="Conversation actions" className="flex flex-wrap items-center gap-2 py-1" role="group">
							<CopyTaskButton className={BUTTON_CLASS} taskText={task.text} />
							{currentTaskItem?.id && (
								<RenameTaskButton className={BUTTON_CLASS} onClick={() => setIsRenaming(true)} />
							)}
							<ExportMarkdownButton className={BUTTON_CLASS} taskId={currentTaskItem?.id} />
							<DeleteTaskButton
								className={BUTTON_CLASS}
								taskId={currentTaskItem?.id}
								taskSize={currentTaskItem?.size}
							/>
							{IS_DEV && (
								<OpenDiskConversationHistoryButton className={BUTTON_CLASS} taskId={currentTaskItem?.id} />
							)}
							{currentTaskItem?.id && (
								<span
									className="select-text text-xs text-description font-mono"
									data-testid="task-ref"
									title="Conversation reference">
									#{conversationRef(currentTaskItem.id)}
								</span>
							)}
							<TaskAgentChip agentPath={currentTaskItem?.agentPath} />
						</div>
						<div
							aria-label="Conversation usage and limits"
							className="flex flex-wrap items-center gap-2 py-1"
							role="group">
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
							{currentTaskItem?.id && (
								<TaskWaitLimit
									minutes={currentTaskItem.waitMinutesPerTurn ?? maxWaitMinutesPerTurn ?? 60}
									taskId={currentTaskItem.id}
								/>
							)}
						</div>
						<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
							{currentTaskItem?.startedTs ? (
								<div className="text-xs text-description">
									Started {formatStartTime(currentTaskItem.startedTs)}
								</div>
							) : null}
						</div>
						<div className="mt-1">
							<UserMessage
								canRestoreWorkspace={canRestoreWorkspaceFromMessage(clineMessages, task.ts)}
								defaultMaxHeight={TASK_HEADER_PROMPT_MAX_HEIGHT}
								files={task.files}
								images={task.images}
								messageTs={task.ts}
								restoreWorkspaceDisabledReason={getRestoreWorkspaceDisabledReason(clineMessages, task.ts)}
								text={task.text}
							/>
						</div>

						<ContextWindow
							autoCompactThreshold={autoCompactThresholdFor(selectedModelInfo, compactionThreshold)}
							cacheReads={cacheReads}
							cacheWrites={cacheWrites}
							compactionThreshold={compactionThreshold}
							contextBreakdown={contextBreakdown}
							contextWindow={selectedModelInfo?.contextWindow}
							hasEstimatedUsage={hasEstimatedUsage}
							lastApiReqTotalTokens={lastApiReqTotalTokens}
							maxInputTokens={selectedModelInfo?.maxInputTokens}
							onCompactionThresholdChange={setCompactionThreshold}
							onSendMessage={onSendMessage}
							prunedTokens={prunedTokens}
							tokensIn={tokensIn}
							tokensOut={tokensOut}
							useAutoCondense={useAutoCondense !== false}
						/>
						<TokenUsagePanel
							clineMessages={clineMessages}
							selectedModelId={selectedModelId}
							showCost={isCostAvailable}
						/>
					</div>
				)}
			</div>
		</div>
	)
}

export default TaskHeader
