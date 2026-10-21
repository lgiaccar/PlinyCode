// Tool-approval ask message builder and compaction notice helpers. Split out
// of message-translator.ts (see message-translator/index.ts).

import type { ClineAskUseSubagents, ClineCompactionInfo, ClineMessage, ClineSubagentUsageInfo } from "@shared/ExtensionMessage"
import { getStringField, parseToolInput } from "./tool-input-parse"
import {
	buildMcpToolPayload,
	extractCommandText,
	parseMcpToolName,
	sdkToolToClineSayTool,
	toDisplaySayTool,
} from "./tool-mapping"
import type { MessageTranslatorState } from "./translator-state"

/**
 * Build the Cline approval ask message for an SDK tool approval request.
 * Keeps approval prompts aligned with the SDK event translator so the webview
 * can render specialized rows (MCP, commands, subagents) instead of a generic
 * tool approval with missing context. `description`, when given, becomes the
 * tool row's content (the rename summary of a `rename_symbol` approval).
 */
export function buildToolApprovalAskMessage(
	toolName: string,
	input: unknown,
	ts: number,
	cwd?: string,
	description?: string,
): ClineMessage {
	const mcpInfo = parseMcpToolName(toolName)
	if (mcpInfo) {
		return {
			ts,
			type: "ask",
			ask: "use_mcp_server",
			text: buildMcpToolPayload(mcpInfo, input),
			partial: false,
		}
	}

	if (toolName === "run_commands" || toolName === "execute_command") {
		return {
			ts,
			type: "ask",
			ask: "command",
			text: extractCommandText(input),
			partial: false,
		}
	}

	if (toolName === "spawn_agent") {
		const parsedInput = parseToolInput(input)
		const taskPrompt = getStringField(parsedInput, "task") ?? ""
		return {
			ts,
			type: "ask",
			ask: "use_subagents",
			text: JSON.stringify({
				prompts: [taskPrompt],
			} satisfies ClineAskUseSubagents),
			partial: false,
		}
	}

	const sayTool = toDisplaySayTool(sdkToolToClineSayTool(toolName, input), cwd)
	return {
		ts,
		type: "ask",
		ask: "tool",
		text: JSON.stringify(description ? { ...sayTool, content: description } : sayTool),
		partial: false,
	}
}

/** The compaction notice kinds that get a divider row, and the mode it shows. */
const COMPACTION_NOTICE_MODES = new Map<unknown, ClineCompactionInfo["mode"]>([
	["auto_compaction", "auto"],
	["manual_compaction", "manual"],
	["overflow_recovery_compaction", "overflow"],
])

/**
 * Extract a compaction divider payload from a status notice's metadata.
 * Mirrors the CLI's parseCompactionNoticeMetadata
 * (apps/cli/src/tui/utils/compaction-status.ts). Returns undefined for
 * non-compaction status notices.
 */
export function parseCompactionNoticeMetadata(metadata: Record<string, unknown> | undefined): ClineCompactionInfo | undefined {
	if (!metadata || (metadata.phase !== "started" && metadata.phase !== "completed" && metadata.phase !== "skipped")) {
		return undefined
	}
	const kind = metadata.kind ?? metadata.reason
	const mode = COMPACTION_NOTICE_MODES.get(kind)
	if (!mode) {
		return undefined
	}
	if (metadata.phase === "started") {
		return { status: "started", mode }
	}
	if (metadata.phase === "skipped") {
		return { status: "skipped", mode }
	}
	return {
		status: "completed",
		mode,
		tokensBefore: asFiniteNumber(metadata.tokensBefore),
		tokensAfter: asFiniteNumber(metadata.tokensAfter),
		messagesBefore: asFiniteNumber(metadata.messagesBefore),
		messagesAfter: asFiniteNumber(metadata.messagesAfter),
		...(typeof metadata.strategy === "string" ? { strategy: metadata.strategy } : {}),
		...(typeof metadata.summary === "string" && metadata.summary ? { summary: metadata.summary } : {}),
	}
}

/** Most summary characters a divider rebuilt from history shows, as the live notice does. */
const DIVIDER_SUMMARY_MAX_CHARS = 8_000

/**
 * The divider of a saved compaction, from its sidecar's compacted messages: a
 * summary at their head is an agentic compaction, anything else a basic one.
 */
export function compactionInfoFromProjection(input: {
	sourceMessageCount: number
	messages: ReadonlyArray<{ content: unknown; metadata?: unknown }>
}): ClineCompactionInfo {
	const first = input.messages[0]
	const metadata = first?.metadata as Record<string, unknown> | undefined
	const text =
		metadata?.kind !== "compaction_summary"
			? ""
			: typeof first?.content === "string"
				? first.content
				: Array.isArray(first?.content)
					? first.content
							.map((block: { type?: string; text?: unknown }) =>
								block?.type === "text" && typeof block.text === "string" ? block.text : "",
							)
							.join("")
					: ""
	return {
		status: "completed",
		mode: "auto",
		messagesBefore: input.sourceMessageCount,
		messagesAfter: input.messages.length,
		strategy: text ? "agentic" : "basic",
		...(text.trim()
			? { summary: text.length > DIVIDER_SUMMARY_MAX_CHARS ? `${text.slice(0, DIVIDER_SUMMARY_MAX_CHARS)}…` : text }
			: {}),
	}
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * The summarizer's call, from a completed compaction notice or a persisted
 * summary message's metadata, as the usage row that adds it to the
 * conversation's cost. Undefined when the compaction used no model or the
 * stream reported nothing.
 */
export function buildCompactionUsageMessage(summarizerUsage: unknown, ts: number): ClineMessage | undefined {
	const payload = compactionUsageInfo(summarizerUsage)
	return payload ? { ts, type: "say", say: "subagent_usage", text: JSON.stringify(payload), partial: false } : undefined
}

/**
 * The summarizer's usage a compaction notice carries, for a task in the
 * background, which has no chat rows to add it from.
 */
export function compactionUsageFromNotice(event: {
	noticeType: string
	metadata?: Record<string, unknown>
}): ClineSubagentUsageInfo | undefined {
	if (event.noticeType !== "status" || !parseCompactionNoticeMetadata(event.metadata)) {
		return undefined
	}
	return compactionUsageInfo(event.metadata?.summarizerUsage)
}

/** The summarizer's usage in the usage row's buckets; see {@link buildCompactionUsageMessage}. */
function compactionUsageInfo(summarizerUsage: unknown): ClineSubagentUsageInfo | undefined {
	if (!summarizerUsage || typeof summarizerUsage !== "object") {
		return undefined
	}
	const usage = summarizerUsage as Record<string, unknown>
	const inputTokens = asFiniteNumber(usage.inputTokens) ?? 0
	const outputTokens = asFiniteNumber(usage.outputTokens) ?? 0
	const cacheReads = asFiniteNumber(usage.cacheReadTokens) ?? 0
	const cacheWrites = asFiniteNumber(usage.cacheWriteTokens) ?? 0
	const cost = asFiniteNumber(usage.totalCost) ?? 0
	if (inputTokens === 0 && outputTokens === 0 && cost === 0) {
		return undefined
	}
	return {
		source: "compaction",
		tokensIn: Math.max(0, inputTokens - cacheReads - cacheWrites),
		tokensOut: outputTokens,
		cacheWrites,
		cacheReads,
		cost,
	}
}

/**
 * The row shown when compaction ran and the request is still over the
 * model's input limit: one message alone can be too large for the model.
 */
export function buildCompactionInsufficientMessage(
	metadata: Record<string, unknown> | undefined,
	ts: number,
): ClineMessage | undefined {
	if (metadata?.phase !== "insufficient") {
		return undefined
	}
	const tokensAfter = asFiniteNumber(metadata.tokensAfter)
	const maxInputTokens = asFiniteNumber(metadata.maxInputTokens)
	const sizes =
		tokensAfter !== undefined && maxInputTokens !== undefined
			? ` (about ${Math.round(tokensAfter / 1000)}k of the model's ${Math.round(maxInputTokens / 1000)}k input tokens)`
			: ""
	return {
		ts,
		type: "say",
		say: "info",
		text: `⚠ The context is still over the model's input limit after compaction${sizes}: the latest message alone may be too large for this model. Shorten it, start a new task, or switch to a model with a larger window.`,
		partial: false,
	}
}

/** Build the say:"compaction" divider message for a compaction status payload. */
export function buildCompactionMessage(info: ClineCompactionInfo, ts: number): ClineMessage {
	return {
		ts,
		type: "say",
		say: "compaction",
		text: JSON.stringify(info),
		partial: false,
	}
}

/**
 * Finalize a dangling "started" compaction divider when the turn ends without
 * the completed/skipped notice (mid-compaction abort or error).
 *
 * This covers auto compaction (driven by turn events). Manual compaction runs
 * outside a turn, so SdkCompactionCoordinator.runCompaction finalizes its own
 * dangling divider in its catch block — if the terminal-state rules change
 * here, change them there too.
 */
export function finalizeDanglingCompaction(
	state: MessageTranslatorState,
	messages: ClineMessage[],
	status: "cancelled" | "failed",
): void {
	const ts = state.takeOpenCompactionTs()
	if (ts === undefined) {
		return
	}
	messages.push(buildCompactionMessage({ status, mode: "auto" }, ts))
}
