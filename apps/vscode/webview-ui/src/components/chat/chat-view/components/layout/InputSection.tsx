import React from "react"
import ChatTextArea from "@/components/chat/ChatTextArea"
import QuotedMessagePreview from "@/components/chat/QuotedMessagePreview"
import type { ScheduleRepeat } from "@/components/chat/scheduleTime"
import { NewTaskWorkspacePicker } from "@/components/workspace/NewTaskWorkspacePicker"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ChatState, MessageHandlers, ScrollBehavior } from "../../types/chatTypes"

interface InputSectionProps {
	chatState: ChatState
	messageHandlers: MessageHandlers
	scrollBehavior: ScrollBehavior
	placeholderText: string
	shouldDisableFilesAndImages: boolean
	selectFilesAndImages: () => Promise<void>
	onSchedulePrompt?: (text: string, images: string[], files: string[], scheduledAt: number, repeat?: ScheduleRepeat) => void
}

/**
 * Input section including quoted message preview and chat text area
 */
export const InputSection: React.FC<InputSectionProps> = ({
	chatState,
	messageHandlers,
	scrollBehavior,
	placeholderText,
	shouldDisableFilesAndImages,
	selectFilesAndImages,
	onSchedulePrompt,
}) => {
	const {
		activeQuote,
		setActiveQuote,
		isTextAreaFocused,
		inputValue,
		setInputValue,
		sendingDisabled,
		selectedImages,
		setSelectedImages,
		selectedFiles,
		setSelectedFiles,
		textAreaRef,
		handleFocusChange,
		lastMessage,
		task,
		nextTaskWorkspace,
		setNextTaskWorkspace,
		clineAsk,
	} = chatState

	const { isAtBottom, scrollToBottomAuto } = scrollBehavior
	const { turnState } = useExtensionState()
	const legacyTaskRunning =
		turnState === undefined &&
		(lastMessage?.partial === true || (lastMessage?.type === "say" && lastMessage.say === "api_req_started"))
	const allowQueuedSubmit = turnState?.phase === "streaming" || turnState?.phase === "awaiting_approval" || legacyTaskRunning
	const submitDisabled = sendingDisabled && !allowQueuedSubmit
	// A side question starts a turn of its own, so it needs a conversation to ask about and an idle agent:
	// a message sent while the agent works joins its turn, and one sent to a pending question answers it.
	const sideQuestionAvailable = !!task && !allowQueuedSubmit && clineAsk !== "followup"

	return (
		<>
			{!task && <NewTaskWorkspacePicker onChange={setNextTaskWorkspace} value={nextTaskWorkspace} />}
			{activeQuote && (
				<div style={{ marginBottom: "-12px", marginTop: "10px" }}>
					<QuotedMessagePreview
						isFocused={isTextAreaFocused}
						onDismiss={() => setActiveQuote(null)}
						text={activeQuote}
					/>
				</div>
			)}

			<ChatTextArea
				activeQuote={activeQuote}
				inputValue={inputValue}
				onFocusChange={handleFocusChange}
				onHeightChange={() => {
					if (isAtBottom) {
						scrollToBottomAuto()
					}
				}}
				onSchedulePrompt={onSchedulePrompt}
				onSelectFilesAndImages={selectFilesAndImages}
				onSend={(delivery, options) =>
					messageHandlers.handleSendMessage(inputValue, selectedImages, selectedFiles, delivery, options)
				}
				placeholderText={placeholderText}
				ref={textAreaRef}
				selectedFiles={selectedFiles}
				selectedImages={selectedImages}
				sendingDisabled={submitDisabled}
				setInputValue={setInputValue}
				setSelectedFiles={setSelectedFiles}
				setSelectedImages={setSelectedImages}
				shouldDisableFilesAndImages={shouldDisableFilesAndImages}
				sideQuestionAvailable={sideQuestionAvailable}
			/>
		</>
	)
}
