import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { SubagentMessagesRequest, type SubagentMessagesUpdate } from "@shared/proto/cline/task"
import { convertProtoToClineMessage } from "@shared/proto-conversions/cline-message"
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { TaskServiceClient } from "@/services/grpc-client"
import { ToolGroupRenderer } from "./chat-view/components/messages/ToolGroupRenderer"
import { filterVisibleMessages, groupLowStakesTools } from "./chat-view/utils/messageUtils"
import { ChatRowErrorBoundary } from "./UndisplayableMessageRow"

/** Messages a transcript view keeps, like the extension's buffer per sub-agent. */
const MAX_TRANSCRIPT_MESSAGES = 300

/** The props the transcript gives each row: ChatRow's, without anything that answers or sends. */
export interface SubagentTranscriptRowProps {
	message: ClineMessage
	isExpanded: boolean
	onToggleExpand: (ts: number) => void
	lastModifiedMessage?: ClineMessage
	isLast: boolean
	onHeightChange: (isTaller: boolean) => void
	onLastRowContentChange: () => void
	onSetQuote: (text: string) => void
}

interface SubagentTranscriptProps {
	agentId: string
	/** Whether the sub-agent is still working; only changes the empty-state text. */
	running: boolean
	/** The chat's row component (ChatRow), passed in so this file does not import it back. */
	Row: ComponentType<SubagentTranscriptRowProps>
}

function applyUpdate(previous: ClineMessage[], update: SubagentMessagesUpdate): ClineMessage[] {
	const incoming = update.messages.map(convertProtoToClineMessage)
	if (update.reset) {
		return incoming.slice(-MAX_TRANSCRIPT_MESSAGES)
	}
	const next = [...previous]
	for (const message of incoming) {
		// Updates are almost always to the newest rows, so search from the end.
		let index = next.length - 1
		while (index >= 0 && next[index].ts !== message.ts) {
			index--
		}
		if (index >= 0) {
			next[index] = message
		} else {
			next.push(message)
		}
	}
	return next.slice(-MAX_TRANSCRIPT_MESSAGES)
}

/** One sub-agent's live transcript, streamed while it is mounted. */
function useSubagentMessages(agentId: string): { messages: ClineMessage[]; loaded: boolean } {
	const [messages, setMessages] = useState<ClineMessage[]>([])
	const [loaded, setLoaded] = useState(false)
	useEffect(() => {
		setMessages([])
		setLoaded(false)
		const unsubscribe = TaskServiceClient.subscribeToSubagentMessages(SubagentMessagesRequest.create({ agentId }), {
			onResponse: (update: SubagentMessagesUpdate) => {
				setMessages((previous) => applyUpdate(previous, update))
				setLoaded(true)
			},
			onError: (error: unknown) => console.error("Error in sub-agent transcript subscription:", error),
			onComplete: () => {},
		})
		return unsubscribe
	}, [agentId])
	return { messages, loaded }
}

const noop = () => {}

/**
 * A sub-agent's work as the main chat would show it, compact and indented under
 * its item in the sub-agents row. Read-only: approvals stay in the main chat.
 */
export function SubagentTranscript({ agentId, running, Row }: SubagentTranscriptProps) {
	const { messages, loaded } = useSubagentMessages(agentId)
	const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
	const scrollRef = useRef<HTMLDivElement | null>(null)
	const stickToBottom = useRef(true)

	const modifiedMessages = useMemo(() => combineApiRequests(combineCommandSequences(messages)), [messages])
	const grouped = useMemo(() => groupLowStakesTools(filterVisibleMessages(modifiedMessages)), [modifiedMessages])
	const lastModifiedMessage = modifiedMessages.at(-1)

	const toggleRow = useCallback((ts: number) => setExpandedRows((previous) => ({ ...previous, [ts]: !previous[ts] })), [])

	// Follow the newest rows while the user has not scrolled up.
	useEffect(() => {
		const element = scrollRef.current
		if (element && stickToBottom.current && grouped.length > 0) {
			element.scrollTop = element.scrollHeight
		}
	}, [grouped])

	if (grouped.length === 0) {
		return (
			<div className="mt-2 text-[11px] opacity-70" data-testid="subagent-transcript-empty">
				{!loaded || running
					? "Waiting for the sub-agent's first output…"
					: "No transcript to show. Sub-agent transcripts are kept only while the conversation is open in this window."}
			</div>
		)
	}

	return (
		<div
			className="mt-2 -mx-2 max-h-[420px] overflow-y-auto border-l-2 border-editor-group-border text-xs"
			data-testid="subagent-transcript"
			onScroll={(event) => {
				const element = event.currentTarget
				stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
			}}
			ref={scrollRef}>
			{grouped.map((messageOrGroup, index) => {
				const isLast = index === grouped.length - 1
				if (Array.isArray(messageOrGroup)) {
					return (
						<ChatRowErrorBoundary key={messageOrGroup[0]?.ts ?? index} message={messageOrGroup}>
							<div className="px-2">
								<ToolGroupRenderer
									allMessages={modifiedMessages}
									isLastGroup={isLast}
									messages={messageOrGroup}
								/>
							</div>
						</ChatRowErrorBoundary>
					)
				}
				return (
					<ChatRowErrorBoundary key={messageOrGroup.ts} message={messageOrGroup}>
						<Row
							isExpanded={expandedRows[messageOrGroup.ts] ?? false}
							isLast={isLast}
							lastModifiedMessage={lastModifiedMessage}
							message={messageOrGroup}
							onHeightChange={noop}
							onLastRowContentChange={noop}
							onSetQuote={noop}
							onToggleExpand={toggleRow}
						/>
					</ChatRowErrorBoundary>
				)
			})}
		</div>
	)
}
