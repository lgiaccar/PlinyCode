import { ClineContextBreakdown, ClineMessage } from "@shared/ExtensionMessage"
import React from "react"
import TaskHeader from "@/components/chat/task-header/TaskHeader"
import { MessageHandlers } from "../../types/chatTypes"

interface TaskSectionProps {
	clineMessages: ClineMessage[]
	task: ClineMessage
	apiMetrics: {
		totalTokensIn: number
		totalTokensOut: number
		totalCacheWrites?: number
		totalCacheReads?: number
		totalCost: number
		hasEstimatedUsage?: boolean
	}
	lastApiReqTotalTokens?: number
	lastContextBreakdown?: ClineContextBreakdown
	selectedModelInfo: {
		supportsPromptCache: boolean
		supportsImages: boolean
	}
	messageHandlers: MessageHandlers
}

/**
 * Task section shown when there's an active task
 * Includes the task header and manages task-specific UI
 */
export const TaskSection: React.FC<TaskSectionProps> = ({
	clineMessages,
	task,
	apiMetrics,
	lastApiReqTotalTokens,
	lastContextBreakdown,
	selectedModelInfo,
	messageHandlers,
}) => {
	return (
		<TaskHeader
			cacheReads={apiMetrics.totalCacheReads}
			cacheWrites={apiMetrics.totalCacheWrites}
			clineMessages={clineMessages}
			contextBreakdown={lastContextBreakdown}
			doesModelSupportPromptCache={selectedModelInfo.supportsPromptCache}
			hasEstimatedUsage={apiMetrics.hasEstimatedUsage}
			lastApiReqTotalTokens={lastApiReqTotalTokens}
			onClose={messageHandlers.handleTaskCloseButtonClick}
			onSendMessage={messageHandlers.handleSendMessage}
			task={task}
			tokensIn={apiMetrics.totalTokensIn}
			tokensOut={apiMetrics.totalTokensOut}
			totalCost={apiMetrics.totalCost}
		/>
	)
}
