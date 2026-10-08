import type { ClineMessage } from "@shared/ExtensionMessage"

export function isVisibleCheckpointUserMessage(message: ClineMessage): boolean {
	return message.type === "say" && (message.say === "task" || message.say === "user_feedback")
}

export function isCheckpointAnswerMessage(messages: ClineMessage[], index: number): boolean {
	const message = messages[index]
	if (message?.type !== "say" || message.say !== "user_feedback") {
		return false
	}
	if (message.answersTool) {
		return true
	}

	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		const previous = messages[cursor]
		if (previous.say === "checkpoint_created") {
			continue
		}
		if (previous.type === "ask") {
			return previous.ask === "followup" || previous.ask === "mistake_limit_reached"
		}
		if (isVisibleCheckpointUserMessage(previous)) {
			return false
		}
	}

	return false
}

function isCheckpointRunUserMessage(messages: ClineMessage[], index: number): boolean {
	return isVisibleCheckpointUserMessage(messages[index]) && !isCheckpointAnswerMessage(messages, index)
}

/** What the conversation needs to know about a chat row the user edits. */
export interface EditedRow {
	text?: string
	/** The row answered the agent's question or rejected a tool; the conversation holds it as a tool result. */
	isAnswer: boolean
	/** 1-based count of prompt rows up to and including this one; answer rows are not prompts. */
	promptOrdinal: number
	/** 1-based count of answer rows with the same text up to and including this one. */
	answerOccurrence: number
}

export function describeEditedRow(messages: ClineMessage[], index: number): EditedRow {
	const rows = messages.slice(0, index + 1).filter(isVisibleCheckpointUserMessage)
	const text = messages[index]?.text?.trim()
	return {
		text,
		isAnswer: messages[index]?.answersTool === true,
		promptOrdinal: rows.filter((row) => !row.answersTool).length,
		answerOccurrence: rows.filter((row) => row.answersTool && row.text?.trim() === text).length,
	}
}

export function getCheckpointRunCountForMessage(messages: ClineMessage[], targetIndex: number): number | undefined {
	if (!isCheckpointRunUserMessage(messages, targetIndex)) {
		return undefined
	}

	let runCount = 0
	for (let index = 0; index <= targetIndex; index += 1) {
		if (isCheckpointRunUserMessage(messages, index)) {
			runCount += 1
		}
	}
	return runCount
}

export function findVisibleCheckpointUserMessageByRun(
	messages: ClineMessage[],
	runCount: number,
): { message: ClineMessage; index: number } | undefined {
	let seenUsers = 0
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index]
		if (!isCheckpointRunUserMessage(messages, index)) {
			continue
		}
		seenUsers += 1
		if (seenUsers === runCount) {
			return { message, index }
		}
	}
	return undefined
}
