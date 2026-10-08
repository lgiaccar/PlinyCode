import { countUserRunMessages, isUserRunMessage } from "@plinycode/core"
import { formatDisplayUserInput, normalizeUserInput, stripModeNotices } from "@plinycode/shared"

/**
 * Canned prompt SdkModeCoordinator sends to drive the plan -> act
 * auto-continuation. Defined here (a leaf module) rather than in the
 * coordinator so display-layer consumers (message-translator, ordinal
 * mapping) don't pull the coordinator's heavy import graph into their tests.
 */
export const ACT_MODE_CONTINUATION_PROMPT = "The user approved switching to act mode. Continue with the approved plan now."

export type SdkUserMessage = {
	role?: unknown
	content?: unknown
	metadata?: unknown
}

export function extractSdkUserText(message: SdkUserMessage): string {
	const { content } = message
	if (typeof content === "string") {
		return content.trim()
	}
	if (!Array.isArray(content)) {
		return ""
	}
	return content
		.map((block) => {
			if (!block || typeof block !== "object") {
				return ""
			}
			const typed = block as { type?: unknown; text?: unknown; content?: unknown }
			if (typed.type === "text" && typeof typed.text === "string") {
				return typed.text.trim()
			}
			if (typed.type === "file" && typeof typed.content === "string") {
				return typed.content.trim()
			}
			return ""
		})
		.filter(Boolean)
		.join("\n")
		.trim()
}

/**
 * Prompts sent to the SDK without a visible user_feedback echo (task
 * resumption, plan -> act auto-continue). They exist in SDK history but not
 * in the visible transcript, so ordinal mapping between the two must skip
 * them or every later user message maps one slot too early.
 */
export function isSyntheticUserPrompt(text: string): boolean {
	// Persisted prompts are wrapped by formatModePrompt as
	// <user_input mode="...">...</user_input>; strip that before matching. A
	// user-initiated plan -> act toggle can additionally prepend a
	// <mode_notice> element to the canned continuation, so strip those too or
	// the synthetic prompt would start counting as a visible user message and
	// shift every later edit/regenerate ordinal by one.
	const normalized = stripModeNotices(normalizeUserInput(text))
	return (
		normalized.startsWith("[TASK RESUMPTION]") ||
		normalized === ACT_MODE_CONTINUATION_PROMPT ||
		// Hook-injected context is model-facing only; the runtime stamps these
		// messages displayRole "system", and this text guard keeps transcripts
		// clean on paths where that metadata is unavailable.
		normalized.startsWith("<hook_context")
	)
}

function hasAttachmentBlocks(message: SdkUserMessage): boolean {
	if (!Array.isArray(message.content)) {
		return false
	}
	let hasAttachment = false
	for (const block of message.content) {
		if (!block || typeof block !== "object") {
			continue
		}
		const type = (block as { type?: unknown }).type
		// Tool results are role "user" in SDK history but are not user input;
		// any media they carry must not make the message count as one.
		if (type === "tool_result" || type === "tool-result") {
			return false
		}
		if (type === "image" || type === "file") {
			hasAttachment = true
		}
	}
	return hasAttachment
}

/**
 * True when the SDK message has no visible user_feedback counterpart. An
 * attachment-only continuation carries the synthetic text alongside the
 * user's image/file blocks AND a visible bubble, so it must still be counted.
 */
interface PersistedHookContextChip {
	hookName: string
	toolName?: string
	status: "completed"
}

/**
 * Parses hook-context blocks out of a runtime-injected user message so replay
 * can reconstruct the hook status rows shown live. Returns [] for anything
 * that is not a hook-context injection. Forged tags inside hook output are
 * escaped by the runtime (`<\hook_context`), so only real blocks match.
 */
export function extractPersistedHookContextChips(message: SdkUserMessage): PersistedHookContextChip[] {
	if (message.role !== "user") {
		return []
	}
	const text = extractSdkUserText(message)
	if (!text.startsWith("<hook_context")) {
		return []
	}
	const chips: PersistedHookContextChip[] = []
	const blockPattern = /<hook_context source="([^"]+)"(?:\s+tool_name="([^"]*)")?[^>]*>/g
	let match: RegExpExecArray | null = blockPattern.exec(text)
	while (match !== null) {
		chips.push({
			hookName: match[1],
			...(match[2] ? { toolName: match[2] } : {}),
			status: "completed",
		})
		match = blockPattern.exec(text)
	}
	return chips
}

export function isSyntheticSdkUserMessage(message: SdkUserMessage): boolean {
	// Runtime-generated messages (hook context, compaction summaries) carry a
	// display role that marks them model-facing only.
	const metadata = message.metadata as { displayRole?: unknown } | undefined
	const displayRole = typeof metadata?.displayRole === "string" ? metadata.displayRole.trim().toLowerCase() : undefined
	if (displayRole === "system" || displayRole === "status") {
		return true
	}
	const text = extractSdkUserText(message)
	return !!text && isSyntheticUserPrompt(text) && !hasAttachmentBlocks(message)
}

/** Indexes of the persisted user messages that have a visible chat row, in order. */
function visibleSdkUserMessageIndexes(sdkMessages: SdkUserMessage[]): number[] {
	const indexes: number[] = []
	sdkMessages.forEach((message, index) => {
		if (message.role !== "user") {
			return
		}
		const text = extractSdkUserText(message)
		const hasUserContent = !!text || hasAttachmentBlocks(message)
		if (hasUserContent && !isSyntheticSdkUserMessage(message)) {
			indexes.push(index)
		}
	})
	return indexes
}

/** Whitespace-insensitive form of a prompt, for comparing a chat row with its persisted message. */
function comparablePromptText(text: string): string {
	return text.replace(/\s+/gu, " ").trim().toLowerCase()
}

function sdkMessageShowsText(message: SdkUserMessage, rowText: string): boolean {
	// Context mentions are resolved and editor state is appended before the
	// prompt is persisted, so the row's text is only expected somewhere inside.
	const expected = comparablePromptText(rowText).slice(0, 80)
	return comparablePromptText(formatDisplayUserInput(extractSdkUserText(message))).includes(expected)
}

/**
 * Maps a visible prompt row to its persisted message: the Nth persisted user
 * message (`promptOrdinal`, 1-based, answer rows excluded), checked against
 * the row's text. When the Nth message shows different text, for example
 * because a queued prompt never reached the agent, the nearest persisted
 * message with the row's text wins instead, so the conversation is never cut
 * after the wrong turn.
 */
function findSdkPromptMessageIndex(sdkMessages: SdkUserMessage[], promptOrdinal: number, rowText?: string): number {
	const candidates = visibleSdkUserMessageIndexes(sdkMessages)
	const byOrdinal = candidates[promptOrdinal - 1] ?? -1
	const text = rowText?.trim()
	if (!text || (byOrdinal !== -1 && sdkMessageShowsText(sdkMessages[byOrdinal], text))) {
		return byOrdinal
	}
	let best = -1
	let bestDistance = Number.POSITIVE_INFINITY
	candidates.forEach((index, position) => {
		const distance = Math.abs(position - (promptOrdinal - 1))
		if (distance < bestDistance && sdkMessageShowsText(sdkMessages[index], text)) {
			best = index
			bestDistance = distance
		}
	})
	return best !== -1 ? best : byOrdinal
}

/** The answer to a question, or the feedback given with a rejected tool, inside a persisted tool result. */
interface SdkToolAnswerLocation {
	/** Index of the persisted message holding the tool result. */
	index: number
	/** Index of the tool-result block in that message's content. */
	blockIndex: number
	kind: "question" | "rejection"
}

function toolResultText(block: Record<string, unknown>): string {
	const { content } = block
	if (typeof content === "string") {
		return content
	}
	if (!Array.isArray(content)) {
		return ""
	}
	return content
		.map((part) =>
			part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.join("\n")
}

const feedbackBlock = (feedback: string) => `<feedback>\n${feedback}\n</feedback>`

/**
 * Finds the tool result that carries a chat answer row: the user's answer to
 * `ask_question`, or the feedback they gave when rejecting a tool. In the
 * persisted history these are tool results, not user messages. `occurrence`
 * (1-based) picks among answers with the same text.
 */
function findSdkToolAnswer(sdkMessages: SdkUserMessage[], answerText: string, occurrence = 1): SdkToolAnswerLocation | undefined {
	const answer = answerText.trim()
	if (!answer) {
		return undefined
	}
	let seen = 0
	for (let index = 0; index < sdkMessages.length; index += 1) {
		const { role, content } = sdkMessages[index]
		if (role !== "user" && role !== "tool") {
			continue
		}
		if (!Array.isArray(content)) {
			continue
		}
		for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
			const block = content[blockIndex] as Record<string, unknown> | undefined
			if (!block || (block.type !== "tool_result" && block.type !== "tool-result")) {
				continue
			}
			const text = toolResultText(block)
			const kind =
				block.name === "ask_question" && block.is_error !== true && text.trim() === answer
					? "question"
					: text.includes(feedbackBlock(answer))
						? "rejection"
						: undefined
			if (kind && ++seen === occurrence) {
				return { index, blockIndex, kind }
			}
		}
	}
	return undefined
}

/**
 * The history to restart from when the user edits an answer row: everything
 * up to and including the tool result, with the answer taken out of it. The
 * edited text is then sent as the next user message, so the model sees its
 * question (or the rejected call) followed by the new answer.
 */
function historyBeforeToolAnswer(sdkMessages: SdkUserMessage[], location: SdkToolAnswerLocation): SdkUserMessage[] {
	const kept = sdkMessages.slice(0, location.index + 1)
	const message = kept[location.index]
	if (!Array.isArray(message.content)) {
		return kept
	}
	const content = message.content.map((part, blockIndex) => {
		if (blockIndex !== location.blockIndex) {
			return part
		}
		const block = part as Record<string, unknown>
		const replacement =
			location.kind === "question"
				? "The user will answer in their next message."
				: toolResultText(block).replace(
						/ The user provided the following feedback:\n<feedback>\n[\s\S]*\n<\/feedback>$/u,
						" The user's feedback follows in their next message.",
					)
		return { ...block, content: replacement }
	})
	kept[location.index] = { ...message, content }
	return kept
}

interface EditRestartPlan {
	/** The history the regenerated conversation starts from. */
	initialMessages: SdkUserMessage[]
	/** Checkpoint run of the edited prompt, for reverting files; undefined for an answer row. */
	checkpointRunCount?: number
	/** Runs left in `initialMessages`: the checkpoints worth carrying over. */
	carriedRuns: number
}

/**
 * Where "Restart from here" cuts the persisted history for an edited chat row.
 * A prompt row cuts just before its persisted message; an answer row keeps the
 * question (or rejected call) and takes the answer out of its tool result.
 */
export function planEditRestart(
	sdkMessages: SdkUserMessage[],
	row: { text?: string; isAnswer: boolean; promptOrdinal: number; answerOccurrence: number },
): EditRestartPlan | undefined {
	if (row.isAnswer) {
		const location = findSdkToolAnswer(sdkMessages, row.text ?? "", row.answerOccurrence)
		if (!location) {
			return undefined
		}
		const initialMessages = historyBeforeToolAnswer(sdkMessages, location)
		return { initialMessages, carriedRuns: countUserRunMessages(initialMessages) }
	}
	const index = findSdkPromptMessageIndex(sdkMessages, row.promptOrdinal, row.text)
	if (index === -1) {
		return undefined
	}
	const initialMessages = sdkMessages.slice(0, index)
	return {
		initialMessages,
		checkpointRunCount: getSdkCheckpointRunCountForMessageIndex(sdkMessages, index),
		carriedRuns: countUserRunMessages(initialMessages),
	}
}

/**
 * Returns the checkpoint run number of a persisted user message: the number
 * core's checkpoint hook gave the run that message started. Uses core's own
 * counter, which skips tool results, hook context, reminders and other
 * runtime-injected messages; counting every role-"user" message instead
 * picks a later checkpoint than the one taken before this message.
 */
function getSdkCheckpointRunCountForMessageIndex(sdkMessages: SdkUserMessage[], targetIndex: number): number | undefined {
	const target = sdkMessages[targetIndex]
	if (target?.role !== "user" || !isUserRunMessage(target)) {
		return undefined
	}
	return countUserRunMessages(sdkMessages.slice(0, targetIndex + 1))
}
