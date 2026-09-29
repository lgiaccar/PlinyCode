// Persisted SDK message history translation: sdkMessagesToClineMessages and
// its helpers. Split out of message-translator.ts (see
// message-translator/index.ts).

import { projectSessionMessagesForDisplay } from "@plinycode/core"
import type { MessageWithMetadata as SdkMessage } from "@plinycode/llms"
import type { AgentEvent } from "@plinycode/shared"
import type { ClineApiReqInfo, ClineMessage } from "@shared/ExtensionMessage"
import { MessageIdMinter } from "../message-id-minter"
import { extractPersistedHookContextChips, isSyntheticSdkUserMessage } from "../sdk-user-message-mapping"
import { translateSessionEvent } from "./live-events"
import { extractToolOutputText } from "./tool-mapping"
import { MessageTranslatorState, normalizeUsageEvent } from "./translator-state"

type SdkContentBlock = Exclude<SdkMessage["content"], string>[number]
type SdkToolUseBlock = Extract<SdkContentBlock, { type: "tool_use" }>
type SdkMessageWithMetrics = SdkMessage & {
	/**
	 * Plan/act mode recovered from the persisted <user_input mode="..."> wrapper before display
	 * sanitization strips it (see sanitizeSdkUserMessagesForDisplay in sdk-task-history.ts).
	 * Only meaningful on user messages; governs the turn that follows.
	 */
	uiMode?: "plan" | "act" | "yolo"
}

function textContentBlocksToText(content: SdkMessage["content"]): string {
	if (typeof content === "string") {
		return content.trim()
	}

	const text: string[] = []
	for (const block of content) {
		if (block.type === "text" && block.text.trim()) {
			text.push(block.text.trim())
		} else if (block.type === "file" && block.content.trim()) {
			text.push(block.content.trim())
		}
	}
	return text.join("\n").trim()
}

function agentEventToMessages(event: AgentEvent, state: MessageTranslatorState): ClineMessage[] {
	return translateSessionEvent(
		{
			type: "agent_event",
			payload: {
				sessionId: "history",
				event,
			},
		},
		state,
	).messages
}

function appendPersistedMetricsMessage(
	clineMessages: ClineMessage[],
	message: SdkMessageWithMetrics,
	state: MessageTranslatorState,
): void {
	if (!message.metrics) {
		return
	}

	const usage = normalizeUsageEvent({
		inputTokens: message.metrics.inputTokens,
		outputTokens: message.metrics.outputTokens,
		cacheReadTokens: message.metrics.cacheReadTokens,
		cacheWriteTokens: message.metrics.cacheWriteTokens,
		cost: message.metrics.cost,
	})

	if (
		usage.tokensIn === 0 &&
		usage.tokensOut === 0 &&
		(usage.cacheWrites ?? 0) === 0 &&
		(usage.cacheReads ?? 0) === 0 &&
		(usage.totalCost ?? 0) === 0
	) {
		return
	}

	clineMessages.push({
		ts: state.nextTs(),
		type: "say",
		say: "api_req_started",
		text: JSON.stringify({
			tokensIn: usage.tokensIn,
			tokensOut: usage.tokensOut,
			cacheWrites: usage.cacheWrites,
			cacheReads: usage.cacheReads,
			cost: usage.totalCost,
		} satisfies ClineApiReqInfo),
		partial: false,
	})
}

function finalizePersistedToolUse(
	toolUse: SdkToolUseBlock,
	state: MessageTranslatorState,
	output?: unknown,
	isError?: boolean,
): ClineMessage[] {
	// Reuse the same content_start → content_end path as live SDK events. The
	// start event seeds MessageTranslatorState with the tool input; the end event
	// produces the final non-partial ClineMessage shape the webview expects.
	agentEventToMessages(
		{
			type: "content_start",
			contentType: "tool",
			toolName: toolUse.name,
			toolCallId: toolUse.id,
			input: toolUse.input,
		} as AgentEvent,
		state,
	)

	return agentEventToMessages(
		{
			type: "content_end",
			contentType: "tool",
			toolName: toolUse.name,
			toolCallId: toolUse.id,
			output,
			error: isError ? extractToolOutputText(output) : undefined,
		} as AgentEvent,
		state,
	)
}

export interface SdkMessagesToClineMessagesOptions {
	/**
	 * Whether the transcript's LAST agent turn ended cleanly (per the session record's status).
	 * Only that final turn is ever retagged into the inferred completion row — persisted
	 * transcripts carry no per-turn outcome, so earlier turns always render as plain text —
	 * and the terminal text of a session that failed, was cancelled, or died mid-run must not
	 * be retagged either, or a reopened broken task would render its dangling response as a
	 * green/plan "done" box. Defaults to true.
	 */
	finalTurnCompleted?: boolean
	/**
	 * The task's working directory (as recorded on the session record), used to
	 * relativize the absolute filesystem paths in persisted tool inputs for
	 * display, matching the live streaming path.
	 */
	cwd?: string
}

/**
 * Convert SDK-persisted LLM messages back into the ClineMessage format used by
 * the webview. Keep this in the live message translator so history rendering
 * and streaming rendering share the same SDK tool → Cline UI mapping.
 */
export function sdkMessagesToClineMessages(
	messages: SdkMessageWithMetrics[],
	minter?: MessageIdMinter,
	options?: SdkMessagesToClineMessagesOptions,
): ClineMessage[] {
	const clineMessages: ClineMessage[] = []
	// Plan/act mode of the turn currently being replayed, recovered from each user message's
	// persisted <user_input mode="..."> wrapper (stamped as `uiMode` before sanitization).
	let currentMode: "plan" | "act" | "yolo" | undefined
	// Use the process-wide minter when provided so regenerated history ids are globally unique
	// and never overlap live-session ids. Falls back to a private minter for standalone tests.
	const state = new MessageTranslatorState(
		minter,
		undefined,
		() => currentMode,
		() => options?.cwd,
	)
	const pendingToolUses = new Map<string, SdkToolUseBlock>()

	const flushUnmatchedToolUses = () => {
		for (const toolUse of pendingToolUses.values()) {
			clineMessages.push(...finalizePersistedToolUse(toolUse, state))
		}
		pendingToolUses.clear()
	}

	// Add or update by ts — the synthesized turn-end `done` below retags an already-emitted
	// text row in place (same ts), mirroring the live path's upsert-by-ts message store.
	const upsertClineMessages = (updates: ClineMessage[]) => {
		for (const update of updates) {
			const existingIndex = clineMessages.findIndex((m) => m.ts === update.ts)
			if (existingIndex !== -1) {
				clineMessages[existingIndex] = update
			} else {
				clineMessages.push(update)
			}
		}
	}

	// Close out the transcript's FINAL agent turn by replaying the same `done` translation as
	// the live path, so a final turn that ended on a text response gets the inferred completion
	// retag (green box in act mode, yellow plan box in plan mode) when rehydrated from SDK
	// history. Only the final turn is eligible: persisted transcripts carry no per-turn
	// outcome, so an earlier turn that the user cancelled mid-response and then followed up on
	// is indistinguishable from one that ended cleanly — retagging it would present an
	// interrupted response as a deliberate turn end. The final turn's outcome IS known (the
	// caller gates it on the session record's status via `finalTurnCompleted`).
	const endFinalTurn = () => {
		upsertClineMessages(
			agentEventToMessages({ type: "done", reason: "completed", text: "", iterations: 0 } as AgentEvent, state),
		)
		state.clearTurnOutcome()
	}

	for (const { message, sourceIndex } of projectSessionMessagesForDisplay(messages)) {
		const sourceMessage = messages[sourceIndex]
		if (message.role === "assistant") {
			flushUnmatchedToolUses()

			if (typeof message.content === "string") {
				const text = message.content.trim()
				if (text) {
					clineMessages.push(
						...agentEventToMessages({ type: "content_end", contentType: "text", text } as AgentEvent, state),
					)
				}
				appendPersistedMetricsMessage(clineMessages, message, state)
				continue
			}

			for (const [blockIndex, block] of message.content.entries()) {
				switch (block.type) {
					case "text":
						if (block.text.trim()) {
							clineMessages.push(
								...agentEventToMessages(
									{
										type: "content_end",
										contentType: "text",
										text: block.text.trim(),
									} as AgentEvent,
									state,
								),
							)
						}
						break
					case "thinking":
						if (block.thinking.trim()) {
							clineMessages.push(
								...agentEventToMessages(
									{
										type: "content_end",
										contentType: "reasoning",
										reasoning: block.thinking.trim(),
									} as AgentEvent,
									state,
								),
							)
						}
						break
					case "image":
						if (block.data && block.mediaType.startsWith("image/")) {
							clineMessages.push(
								...agentEventToMessages(
									{
										type: "content_end",
										contentType: "media",
										media: {
											id: `${message.id ?? `history-${sourceIndex}`}:media:${blockIndex}`,
											modality: "image",
											mediaType: block.mediaType,
											source: { type: "base64", data: block.data },
										},
									} as AgentEvent,
									state,
								),
							)
						}
						break
					case "media":
						clineMessages.push(
							...agentEventToMessages(
								{
									type: "content_end",
									contentType: "media",
									media: block.media,
								} as AgentEvent,
								state,
							),
						)
						break
					case "tool_use":
						// Tool activity after a text block means that text wasn't the
						// turn-final response (also covers dangling tool_use blocks whose
						// results never arrived — an aborted turn must not retag).
						state.clearTurnFinalText()
						pendingToolUses.set(block.id, block)
						break
				}
			}
			appendPersistedMetricsMessage(clineMessages, message, state)
			continue
		}

		// Runtime-injected hook context is not a user turn: reconstruct the hook
		// status rows shown live and leave turn/mode state untouched, so the
		// final turn's completion retag survives the injection.
		const hookChips = extractPersistedHookContextChips(message)
		if (hookChips.length > 0) {
			for (const chip of hookChips) {
				clineMessages.push({
					ts: state.nextTs(),
					type: "say",
					say: "hook_status",
					text: JSON.stringify(chip),
					partial: false,
				})
			}
			continue
		}

		if (typeof message.content === "string") {
			const text = message.content.trim()
			if (text) {
				// User text marks a turn boundary: drop the preceding turn's outcome
				// signals (its text is NOT retagged — see endFinalTurn) and pick up the mode
				// of the NEW turn from this message's wrapper. Synthetic runtime prompts
				// (task resumption, plan -> act auto-continue) still advance the turn/mode
				// state but never had a visible bubble live, so don't emit one here either.
				state.clearTurnOutcome()
				currentMode = sourceMessage.uiMode ?? currentMode
				if (!isSyntheticSdkUserMessage(message)) {
					clineMessages.push({
						ts: state.nextTs(),
						type: "say",
						say: clineMessages.length === 0 ? "task" : "user_feedback",
						text,
						partial: false,
					})
				}
			}
			continue
		}

		const userText = textContentBlocksToText(message.content)
		if (userText) {
			state.clearTurnOutcome()
			currentMode = sourceMessage.uiMode ?? currentMode
			if (!isSyntheticSdkUserMessage(message)) {
				clineMessages.push({
					ts: state.nextTs(),
					type: "say",
					say: clineMessages.length === 0 ? "task" : "user_feedback",
					text: userText,
					partial: false,
				})
			}
		}

		for (const block of message.content) {
			if (block.type !== "tool_result") {
				continue
			}

			const toolUse = pendingToolUses.get(block.tool_use_id)
			if (!toolUse) {
				continue
			}

			pendingToolUses.delete(block.tool_use_id)
			clineMessages.push(...finalizePersistedToolUse(toolUse, state, block.content, block.is_error))
		}
	}

	// Close out the transcript's final agent turn so its terminal text (if the turn ended on
	// text) gets the inferred completion retag. Skipped when the session record says the last
	// run failed, was cancelled, or died mid-turn: its terminal text is a dangling partial
	// response, not a completion, and must stay a plain text row.
	if (options?.finalTurnCompleted !== false) {
		endFinalTurn()
	}

	// Always emit ask:"completion_result"
	// as the LAST message so it comes after the usage event's
	// say:"api_req_started". This is critical: the webview uses
	// the last raw message to determine UI state. If the usage
	// event is last, the webview shows "Thinking..." instead of
	// the completion UI
	clineMessages.push({
		ts: state.nextTs(),
		type: "ask",
		ask: "completion_result",
		text: "",
		partial: false,
	})

	flushUnmatchedToolUses()
	return clineMessages
}
