import type { ClineMessage } from "@shared/ExtensionMessage"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import type React from "react"
import { useId, useMemo } from "react"
import ChatRow from "@/components/chat/ChatRow"
import { ChatRowErrorBoundary } from "@/components/chat/UndisplayableMessageRow"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import type { MessageHandlers } from "../../types/chatTypes"
import { type ActivityGroup, isActivityGroup } from "../../utils/activityGroups"
import { findReasoningForApiReq, getTurnBoundaryLabels, isToolGroup } from "../../utils/messageUtils"
import { ToolGroupRenderer } from "./ToolGroupRenderer"

interface ActivityExpansion {
	isExpanded: (groupTs: number) => boolean
	onToggle: (groupTs: number) => void
}

interface MessageRendererProps {
	index: number
	messageOrGroup: ClineMessage | ClineMessage[]
	groupedMessages: (ClineMessage | ClineMessage[])[]
	modifiedMessages: ClineMessage[]
	expandedRows: Record<number, boolean>
	onToggleExpand: (ts: number, options?: { preserveAutoScroll?: boolean }) => void
	onHeightChange: (isTaller: boolean) => void
	onLastRowContentChange: () => void
	onSetQuote: (quote: string | null) => void
	inputValue: string
	messageHandlers: MessageHandlers
	footerActive: boolean
	activityExpansion: ActivityExpansion
	turnBoundaryLabel?: string
}

const ActivityGroupRenderer: React.FC<{ group: ActivityGroup; props: MessageRendererProps }> = ({ group, props }) => {
	const expanded = props.activityExpansion.isExpanded(group[0].ts)
	const contentId = useId()
	const { turnState } = useExtensionState()
	const working = props.index === props.groupedMessages.length - 1 && turnState?.phase === "streaming"
	return (
		<div className="px-4 pt-2.5" data-message-ts={group[0]?.ts}>
			<button
				aria-controls={expanded ? contentId : undefined}
				aria-expanded={expanded}
				className="flex items-center gap-1 text-description text-[13px] hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--vscode-focusBorder)]"
				onClick={() => props.activityExpansion.onToggle(group[0].ts)}
				type="button">
				{expanded ? <ChevronDownIcon className="size-1.5" /> : <ChevronRightIcon className="size-1.5" />}
				{expanded ? "Hide activity" : working ? "Working... Show activity" : "Show activity"}
			</button>
			{expanded && (
				<div className="border-l border-editor-group-border ml-1 mt-1" id={contentId}>
					{group.items.map((item, index) => (
						<ChatRowErrorBoundary key={Array.isArray(item) ? item[0]?.ts : item.ts} message={item}>
							<MessageRenderer {...props} groupedMessages={group.items} index={index} messageOrGroup={item} />
						</ChatRowErrorBoundary>
					))}
				</div>
			)}
		</div>
	)
}

/**
 * Specialized component for rendering different message types
 * Handles tool groups, regular messages, and checkpoint logic
 */
const MessageRenderer: React.FC<MessageRendererProps> = ({
	index,
	messageOrGroup,
	groupedMessages,
	modifiedMessages,
	expandedRows,
	onToggleExpand,
	onHeightChange,
	onLastRowContentChange,
	onSetQuote,
	inputValue,
	messageHandlers,
	footerActive,
	activityExpansion,
	turnBoundaryLabel,
}) => {
	const { mode } = useExtensionState()

	const isLastMessage = useMemo(() => index === groupedMessages?.length - 1, [groupedMessages, index])

	// Get reasoning content and response status for api_req_started messages
	const reasoningData = useMemo(() => {
		if (!Array.isArray(messageOrGroup) && messageOrGroup.say === "api_req_started") {
			// Use the same message source-of-truth that `groupedMessages` is derived from.
			return findReasoningForApiReq(messageOrGroup.ts, modifiedMessages)
		}
		return { reasoning: undefined, responseStarted: false }
	}, [messageOrGroup, modifiedMessages])

	// Tool group (low-stakes tools grouped together)
	// Determine if this is the last tool group to show active items
	const isLastToolGroup = useMemo(() => {
		if (!isToolGroup(messageOrGroup)) {
			return false
		}
		// Find the last tool group in groupedMessages
		for (let i = groupedMessages.length - 1; i >= 0; i--) {
			if (isToolGroup(groupedMessages[i])) {
				return i === index
			}
		}
		return false
	}, [messageOrGroup, groupedMessages, index])

	// Tool group (the only kind of message group)
	if (isActivityGroup(messageOrGroup)) {
		return (
			<ActivityGroupRenderer
				group={messageOrGroup}
				props={{
					index,
					messageOrGroup,
					groupedMessages,
					modifiedMessages,
					expandedRows,
					onToggleExpand,
					onHeightChange,
					onLastRowContentChange,
					onSetQuote,
					inputValue,
					messageHandlers,
					footerActive,
					activityExpansion,
				}}
			/>
		)
	}
	if (Array.isArray(messageOrGroup)) {
		return <ToolGroupRenderer allMessages={modifiedMessages} isLastGroup={isLastToolGroup} messages={messageOrGroup} />
	}

	// Regular message
	return (
		<div
			className={cn({
				"pb-2.5": isLastMessage && !footerActive,
			})}
			data-message-ts={messageOrGroup.ts}>
			{turnBoundaryLabel && (
				<div className="flex min-w-0 items-center gap-2 px-4 pt-5">
					<h3 className="m-0 shrink-0 text-[11px] font-medium text-description">{turnBoundaryLabel}</h3>
					<span aria-hidden="true" className="min-w-0 flex-1 border-t border-editor-group-border" />
				</div>
			)}
			<ChatRow
				inputValue={inputValue}
				isExpanded={expandedRows[messageOrGroup.ts] || false}
				isLast={isLastMessage}
				key={messageOrGroup.ts}
				lastModifiedMessage={modifiedMessages.at(-1)}
				message={messageOrGroup}
				mode={mode}
				onCancelCommand={() => messageHandlers.executeButtonAction("cancel")}
				onHeightChange={onHeightChange}
				onLastRowContentChange={onLastRowContentChange}
				onSetQuote={onSetQuote}
				onToggleExpand={onToggleExpand}
				reasoningContent={reasoningData.reasoning}
				responseStarted={reasoningData.responseStarted}
				sendMessageFromChatRow={messageHandlers.handleSendMessage}
			/>
		</div>
	)
}

/**
 * Factory function to create the itemContent callback for Virtuoso
 * This allows us to encapsulate the rendering logic while maintaining performance
 */
export const createMessageRenderer = (
	groupedMessages: (ClineMessage | ClineMessage[])[],
	modifiedMessages: ClineMessage[],
	expandedRows: Record<number, boolean>,
	onToggleExpand: (ts: number, options?: { preserveAutoScroll?: boolean }) => void,
	onHeightChange: (isTaller: boolean) => void,
	onLastRowContentChange: () => void,
	onSetQuote: (quote: string | null) => void,
	inputValue: string,
	messageHandlers: MessageHandlers,
	footerActive: boolean,
	activityExpansion: ActivityExpansion,
) => {
	const turnBoundaryLabels = getTurnBoundaryLabels(groupedMessages)
	// Each row gets its own error boundary, so one row that throws while rendering
	// shows a compact fallback instead of blanking the whole list.
	return (index: number, messageOrGroup: ClineMessage | ClineMessage[]) => (
		<ChatRowErrorBoundary
			key={Array.isArray(messageOrGroup) ? messageOrGroup[0]?.ts : messageOrGroup.ts}
			message={messageOrGroup}>
			<MessageRenderer
				activityExpansion={activityExpansion}
				expandedRows={expandedRows}
				footerActive={footerActive}
				groupedMessages={groupedMessages}
				index={index}
				inputValue={inputValue}
				messageHandlers={messageHandlers}
				messageOrGroup={messageOrGroup}
				modifiedMessages={modifiedMessages}
				onHeightChange={onHeightChange}
				onLastRowContentChange={onLastRowContentChange}
				onSetQuote={onSetQuote}
				onToggleExpand={onToggleExpand}
				turnBoundaryLabel={turnBoundaryLabels[index]}
			/>
		</ChatRowErrorBoundary>
	)
}
