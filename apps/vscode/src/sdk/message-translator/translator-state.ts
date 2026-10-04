// Translation result type, usage normalization, and the streaming-state
// class used to translate SDK events into ClineMessage[]. Split out of
// message-translator.ts (see message-translator/index.ts).

import { truncateCommandOutput } from "@plinycode/core"
import type { UserInputMode } from "@plinycode/shared"
import type { ClineContextBreakdown, ClineMessage, ClineSaySubagentStatus, SubagentStatusItem } from "@shared/ExtensionMessage"
import { MessageIdMinter } from "../message-id-minter"
import { isDeniedToolApprovalMistake } from "../tool-approval-denial"

// ---------------------------------------------------------------------------
// Translation result
// ---------------------------------------------------------------------------

/**
 * Result of translating a single SDK event into ClineMessages.
 * May produce zero or more messages.
 */
export interface TranslationResult {
	/** Messages produced by this event */
	messages: ClineMessage[]
	/** Whether the session has ended */
	sessionEnded: boolean
	/** Whether the agent turn is complete */
	turnComplete: boolean
	/** Whether a tool call ended with an error (content_end with event.error) */
	toolError?: boolean
	/** Whether a tool call ended successfully (content_end without error) */
	toolSuccess?: boolean
	/** Usage info if available */
	usage?: {
		tokensIn: number
		tokensOut: number
		cacheWrites?: number
		cacheReads?: number
		totalCost?: number
		estimated?: boolean
		contextBreakdown?: ClineContextBreakdown
	}
}

type NormalizedUsage = NonNullable<TranslationResult["usage"]>

export function normalizeUsageEvent(usageEvent: {
	inputTokens?: number
	outputTokens?: number
	cacheReadTokens?: number
	cacheWriteTokens?: number
	cost?: number
	totalCost?: number
	estimated?: boolean
	contextBreakdown?: ClineContextBreakdown
}): NormalizedUsage {
	const inputTokens = usageEvent.inputTokens ?? 0
	const cacheReads = usageEvent.cacheReadTokens ?? 0
	const cacheWrites = usageEvent.cacheWriteTokens ?? 0

	// SDK provider usage reports inputTokens as the full request size, with
	// cache reads/writes included. Classic Cline/webview metrics expect
	// tokensIn, cacheReads, and cacheWrites to be disjoint buckets.
	const uncachedInputTokens = Math.max(0, inputTokens - cacheReads - cacheWrites)

	return {
		tokensIn: uncachedInputTokens,
		tokensOut: usageEvent.outputTokens ?? 0,
		cacheWrites,
		cacheReads,
		totalCost: usageEvent.cost ?? usageEvent.totalCost ?? 0,
		...(usageEvent.estimated ? { estimated: true } : {}),
		...(usageEvent.contextBreakdown ? { contextBreakdown: usageEvent.contextBreakdown } : {}),
	}
}

// ---------------------------------------------------------------------------
// State tracking for partial messages
// ---------------------------------------------------------------------------

/**
 * Tracks the state of streaming content to properly handle
 * partial message updates.
 */
export class MessageTranslatorState {
	/** Current streaming text message timestamp (used for dedup) */
	private streamingTextTs: number | undefined
	/** Current streaming reasoning message timestamp */
	private streamingReasoningTs: number | undefined
	/** Accumulated streaming reasoning text (SDK reasoning events are deltas) */
	private streamingReasoningText = ""
	/** Current streaming tool message timestamp */
	private streamingToolTs: number | undefined
	/** Stored tool input from content_start — used at content_end which doesn't carry input */
	private streamingToolInput: unknown | undefined
	/** Stored tool name from content_start — used at content_end for consistency */
	private streamingToolName: string | undefined
	/** Output snapshot for the active command tool's partial row. */
	private streamingCommandOutput: { toolCallId: string | undefined; text: string; totalChars: number } | undefined
	/** Approved tool-call ids mapped to the approval row that should be updated in place. */
	private approvedToolMessageTsByCallId = new Map<string, number>()
	/**
	 * The in-flight compaction divider's ts, so the "completed"/"skipped" notice
	 * (or a turn error/abort) updates the same row in place. Deliberately NOT
	 * cleared by the per-iteration `reset()`: the started/completed notices both
	 * fire inside prepareTurn, before the next `iteration_start`, but an error
	 * or abort mid-compaction must still be able to finalize the open row.
	 */
	private openCompactionTs: number | undefined
	/** Tool calls rejected by the user; they should not render as red tool failures. */
	private deniedToolApprovalsByCallId = new Map<string, { toolName: string; reason: string }>()
	/**
	 * Process-wide id/seq/epoch authority. Shared with the interaction coordinator and history
	 * rendering so that message ids never collide across generators. See message-id-minter.ts.
	 */
	private readonly minter: MessageIdMinter

	constructor(
		minter: MessageIdMinter = new MessageIdMinter(),
		private readonly getActiveProviderId?: () => string | undefined,
		private readonly getUiMode?: () => UserInputMode | undefined,
		private readonly getCwd?: () => string | undefined,
		private readonly getActiveModelId?: () => string | undefined,
	) {
		this.minter = minter
	}

	/** Provider backing the active turn, if the host can supply it. */
	activeProviderId(): string | undefined {
		return this.getActiveProviderId?.()
	}

	/** Model backing the active turn, if the host can supply it. */
	activeModelId(): string | undefined {
		return this.getActiveModelId?.()
	}

	/**
	 * The task's working directory, used to relativize the absolute filesystem
	 * paths in tool inputs before they reach the webview. Undefined when the
	 * host doesn't supply a cwd source (paths are then displayed as-is).
	 */
	currentCwd(): string | undefined {
		return this.getCwd?.()
	}

	/**
	 * Plan/act mode governing the current turn, used to style the inferred turn-final
	 * response (plan → yellow plan box, act/yolo → green completion box).
	 * Defaults to act when the host doesn't supply a mode source.
	 */
	currentUiMode(): "plan" | "act" {
		return this.getUiMode?.() === "plan" ? "plan" : "act"
	}

	/** The shared minter, exposed so coordinators and history rendering mint from the same source. */
	getMinter(): MessageIdMinter {
		return this.minter
	}

	/** Generate a unique message id (identity). Pure monotonic counter; never reads the clock. */
	nextTs(): number {
		return this.minter.nextId()
	}

	/** Mint and remember the ts of an in-flight compaction divider. */
	beginCompaction(): number {
		this.openCompactionTs = this.nextTs()
		return this.openCompactionTs
	}

	/** Take (and clear) the in-flight compaction divider's ts, if any. */
	takeOpenCompactionTs(): number | undefined {
		const ts = this.openCompactionTs
		this.openCompactionTs = undefined
		return ts
	}

	/** Get and increment for streaming text */
	getStreamingTextTs(): number {
		if (!this.streamingTextTs) {
			this.streamingTextTs = this.nextTs()
		}
		return this.streamingTextTs
	}

	/** Clear streaming text (content ended) */
	clearStreamingText(): number {
		const ts = this.streamingTextTs ?? this.nextTs()
		this.streamingTextTs = undefined
		return ts
	}

	/** Get and increment for streaming reasoning */
	getStreamingReasoningTs(): number {
		if (!this.streamingReasoningTs) {
			this.streamingReasoningTs = this.nextTs()
		}
		return this.streamingReasoningTs
	}

	/** Append a reasoning delta and return the accumulated reasoning text */
	appendStreamingReasoning(reasoningDelta: string): string {
		this.streamingReasoningText += reasoningDelta
		return this.streamingReasoningText
	}

	/** Clear streaming reasoning (content ended) */
	clearStreamingReasoning(): number {
		const ts = this.streamingReasoningTs ?? this.nextTs()
		this.streamingReasoningTs = undefined
		this.streamingReasoningText = ""
		return ts
	}

	/** Get streaming tool ts */
	getStreamingToolTs(): number {
		if (!this.streamingToolTs) {
			this.streamingToolTs = this.nextTs()
		}
		return this.streamingToolTs
	}

	/** Store tool input from content_start for use at content_end */
	setStreamingToolContext(toolName: string, toolCallId: string | undefined, input: unknown): void {
		this.streamingToolName = toolName
		this.streamingToolInput = input
		this.streamingCommandOutput = { toolCallId, text: "", totalChars: 0 }
	}

	/** Remember the approval prompt row for a tool call after the user approves it. */
	recordApprovedToolMessageTs(toolCallId: string, messageTs: number): void {
		this.approvedToolMessageTsByCallId.set(toolCallId, messageTs)
	}

	/** Clear approved prompt rows that no longer have a live tool event to consume them. */
	clearApprovedToolMessageTs(): void {
		this.approvedToolMessageTsByCallId.clear()
	}

	recordDeniedToolApproval(toolCallId: string, toolName: string, reason: string): void {
		this.deniedToolApprovalsByCallId.set(toolCallId, { toolName, reason })
	}

	isToolApprovalDenied(toolCallId: string | undefined): boolean {
		return toolCallId !== undefined && this.deniedToolApprovalsByCallId.has(toolCallId)
	}

	/**
	 * Returns true when the given toolCallId was previously denied and its events should be
	 * suppressed. This intentionally does not remove the entry because the denial must persist
	 * past content_end so the follow-on error event can also be suppressed.
	 */
	checkDeniedToolApproval(toolCallId: string | undefined): boolean {
		if (toolCallId === undefined || !this.deniedToolApprovalsByCallId.has(toolCallId)) {
			return false
		}
		return true
	}

	isSuppressedToolApprovalDenial(value: unknown): boolean {
		return isDeniedToolApprovalMistake(value, this.deniedToolApprovalsByCallId.values())
	}

	/** Reuse and remove a previously-approved prompt row for the matching tool event. */
	consumeApprovedToolMessageTs(toolCallId: string | undefined): number | undefined {
		if (!toolCallId) {
			return undefined
		}
		const messageTs = this.approvedToolMessageTsByCallId.get(toolCallId)
		if (messageTs !== undefined) {
			this.approvedToolMessageTsByCallId.delete(toolCallId)
		}
		return messageTs
	}

	/** Force the active tool stream to update a known row instead of minting a new row. */
	setStreamingToolTs(ts: number): void {
		this.streamingToolTs = ts
	}

	/** Get the stored tool input (from content_start) */
	getStreamingToolInput(): unknown | undefined {
		return this.streamingToolInput
	}

	/** Get the stored tool name (from content_start) */
	getStreamingToolName(): string | undefined {
		return this.streamingToolName
	}

	appendStreamingCommandOutput(toolCallId: string | undefined, chunk: string): string | undefined {
		const output = this.streamingCommandOutput
		if (!output || (toolCallId !== undefined && toolCallId !== output.toolCallId)) {
			return undefined
		}
		output.totalChars += chunk.length
		output.text = truncateCommandOutput(output.text + chunk, {
			totalChars: output.totalChars,
		})
		return output.text
	}

	isMismatchedStreamingCommand(toolName: string, toolCallId: string | undefined): boolean {
		const output = this.streamingCommandOutput
		return (
			output !== undefined &&
			(this.streamingToolName !== toolName || (toolCallId !== undefined && toolCallId !== output.toolCallId))
		)
	}

	/** Clear streaming tool */
	clearStreamingTool(): number {
		const ts = this.streamingToolTs ?? this.nextTs()
		this.streamingToolTs = undefined
		this.streamingToolInput = undefined
		this.streamingToolName = undefined
		this.streamingCommandOutput = undefined
		return ts
	}

	/** Whether attempt_completion tool was called in this turn */
	private attemptCompletionSeen = false

	/** Mark that attempt_completion was called */
	setAttemptCompletionSeen(): void {
		this.attemptCompletionSeen = true
	}

	/** Check if attempt_completion was called in this turn */
	wasAttemptCompletionSeen(): boolean {
		return this.attemptCompletionSeen
	}

	/** Whether a provider/agent error surfaced in this turn (ask:"api_req_failed" emitted) */
	private errorSeen = false

	/** Mark that this turn surfaced an error */
	setErrorSeen(): void {
		this.errorSeen = true
	}

	/** Check if this turn surfaced an error — drives the "error" turn phase (Retry / New Task) */
	wasErrorSeen(): boolean {
		return this.errorSeen
	}

	// -----------------------------------------------------------------------
	// Turn-final text tracking — the SDK agent usually ends a turn with a plain
	// text response instead of a completion tool. When a turn ends cleanly with
	// text as its last content, that text row is retagged in place (same ts) to
	// say:"completion_result" (act) or say:"plan_completion_result" (plan) so
	// the webview shows the legacy-style completion feedback box.
	// -----------------------------------------------------------------------

	/** ts of the last finalized (non-partial, non-empty) text message of the current turn */
	private turnFinalTextTs: number | undefined
	/** Text of the message tracked by turnFinalTextTs */
	private turnFinalText = ""

	/** Remember the most recent finalized text as the candidate turn-final response. */
	recordTurnFinalText(ts: number, text: string): void {
		this.turnFinalTextTs = ts
		this.turnFinalText = text
	}

	/** Forget the candidate turn-final text (tool activity means the turn didn't end on it). */
	clearTurnFinalText(): void {
		this.turnFinalTextTs = undefined
		this.turnFinalText = ""
	}

	/** Take (and clear) the candidate turn-final text, if any. */
	takeTurnFinalText(): { ts: number; text: string } | undefined {
		if (this.turnFinalTextTs === undefined) {
			return undefined
		}
		const result = { ts: this.turnFinalTextTs, text: this.turnFinalText }
		this.clearTurnFinalText()
		return result
	}

	// -----------------------------------------------------------------------
	// spawn_agent tracking — aggregates parallel spawn_agent tool calls into
	// the rich SubagentStatusRow UI (use_subagents + subagent messages).
	// -----------------------------------------------------------------------

	/** Active spawn_agent entries keyed by toolCallId */
	private spawnAgentEntries = new Map<string, SubagentStatusItem>()
	/** Stable timestamp for the combined say:"use_subagents" prompts message */
	private spawnAgentPromptsTs: number | undefined
	/** Stable timestamp for the combined say:"subagent" status message */
	private spawnAgentStatusTs: number | undefined
	/** Counter for assigning index to new spawn_agent entries */
	private spawnAgentNextIndex = 0

	/** Register a new spawn_agent call. Returns the entry for this call. */
	addSpawnAgent(toolCallId: string, prompt: string): SubagentStatusItem {
		const entry: SubagentStatusItem = {
			index: ++this.spawnAgentNextIndex,
			prompt,
			status: "running",
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			contextTokens: 0,
			contextWindow: 0,
			contextUsagePercentage: 0,
		}
		this.spawnAgentEntries.set(toolCallId, entry)
		return entry
	}

	/** Get a spawn_agent entry by toolCallId */
	getSpawnAgent(toolCallId: string): SubagentStatusItem | undefined {
		return this.spawnAgentEntries.get(toolCallId)
	}

	/** Whether there are any active spawn_agent calls */
	hasSpawnAgents(): boolean {
		return this.spawnAgentEntries.size > 0
	}

	/** Whether any registered spawn_agent call has not finished yet. */
	hasRunningSpawnAgents(): boolean {
		return this.getSpawnAgentItems().some((entry) => entry.status === "running" || entry.status === "pending")
	}

	/** Get all spawn_agent entries as an ordered array */
	getSpawnAgentItems(): SubagentStatusItem[] {
		return Array.from(this.spawnAgentEntries.values()).sort((a, b) => a.index - b.index)
	}

	/** Get or create the stable timestamp for say:"use_subagents" prompts messages */
	getSpawnAgentPromptsTs(): number {
		if (!this.spawnAgentPromptsTs) {
			this.spawnAgentPromptsTs = this.nextTs()
		}
		return this.spawnAgentPromptsTs
	}

	/** Force the aggregated spawn-agent prompt row to update a known approval row. */
	setSpawnAgentPromptsTs(ts: number): void {
		this.spawnAgentPromptsTs = ts
	}

	/** Get or create the stable timestamp for subagent status messages */
	getSpawnAgentStatusTs(): number {
		if (!this.spawnAgentStatusTs) {
			this.spawnAgentStatusTs = this.nextTs()
		}
		return this.spawnAgentStatusTs
	}

	/** Build a ClineSaySubagentStatus from the current entries */
	buildSubagentStatus(overallStatus: ClineSaySubagentStatus["status"]): ClineSaySubagentStatus {
		const items = this.getSpawnAgentItems()
		const completed = items.filter((e) => e.status === "completed" || e.status === "failed").length
		const successes = items.filter((e) => e.status === "completed").length
		const failures = items.filter((e) => e.status === "failed").length
		return {
			status: overallStatus,
			total: items.length,
			completed,
			successes,
			failures,
			toolCalls: items.reduce((acc, e) => acc + (e.toolCalls || 0), 0),
			inputTokens: items.reduce((acc, e) => acc + (e.inputTokens || 0), 0),
			outputTokens: items.reduce((acc, e) => acc + (e.outputTokens || 0), 0),
			contextWindow: items.reduce((acc, e) => Math.max(acc, e.contextWindow || 0), 0),
			maxContextTokens: items.reduce((acc, e) => Math.max(acc, e.contextTokens || 0), 0),
			maxContextUsagePercentage: items.reduce((acc, e) => Math.max(acc, e.contextUsagePercentage || 0), 0),
			items,
		}
	}

	/** Clear all spawn_agent state (called at iteration_start) */
	clearSpawnAgents(): void {
		this.spawnAgentEntries.clear()
		this.spawnAgentPromptsTs = undefined
		this.spawnAgentStatusTs = undefined
		this.spawnAgentNextIndex = 0
	}

	/**
	 * Reset per-iteration STREAMING state: the open text/reasoning/tool stream pointers and the
	 * spawn-agent aggregation. Called on each `iteration_start`, which is mid-turn within the same
	 * conversation, so it deliberately does NOT touch turn-outcome signals such as
	 * `attemptCompletionSeen` — those are scoped to the whole turn and survive its iterations.
	 */
	reset(): void {
		this.streamingTextTs = undefined
		this.streamingReasoningTs = undefined
		this.streamingToolTs = undefined
		this.streamingToolInput = undefined
		this.streamingToolName = undefined
		this.streamingCommandOutput = undefined
		this.clearApprovedToolMessageTs()
		this.deniedToolApprovalsByCallId.clear()
		this.clearSpawnAgents()
	}

	/**
	 * Clear turn-outcome signals (`attemptCompletionSeen`, the turn-final text candidate).
	 * Called at a new user turn / task boundary so each turn's phase is computed fresh; it is
	 * intentionally separate from the per-iteration `reset()` so the completion signal persists
	 * across the iterations of one turn.
	 */
	clearTurnOutcome(): void {
		this.attemptCompletionSeen = false
		this.errorSeen = false
		this.clearTurnFinalText()
	}
}
