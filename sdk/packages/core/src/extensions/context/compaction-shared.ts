import type { ModelInfo, ToolResultContent } from "@plinycode/llms";
import {
	CHARS_PER_TOKEN,
	estimateTokens,
	formatDisplayUserInput,
	type MessageWithMetadata,
	serializeForTokenEstimate,
} from "@plinycode/shared";

export { CHARS_PER_TOKEN, estimateTokens };

import { isUserRunMessage } from "../../session/user-run-messages";
import type { CoreCompactionSummarizerConfig } from "../../types/config";
import type { ProviderConfig } from "../../types/provider-settings";

export const DEFAULT_MAX_INPUT_TOKENS = 128_000;
/** Estimate the usable input share when only a context window is reported. */
export const CONTEXT_WINDOW_INPUT_RATIO = 0.9;
/** Compact once the transcript consumes this share of the usable input budget. */
export const COMPACTION_TRIGGER_RATIO = 0.9;
/**
 * Upper bound on how far the provider's actual input count may scale the
 * compaction budget down relative to the character-based estimate. Dense
 * content realistically tokenizes ~2-3x denser than the 3-chars-per-token
 * assumption; the cap stops a pathologically small estimate from collapsing
 * the budget and compacting every turn.
 */
export const MAX_INPUT_UNDERESTIMATE_FACTOR = 4;
/**
 * Lower bound on the same ratio: a provider that reports only the uncached
 * part of its input would otherwise loosen the budget below what the
 * per-model calibration allows.
 */
export const MIN_INPUT_UNDERESTIMATE_FACTOR = 0.5;
export const DEFAULT_TARGET_RATIO = 0.7;
export const DEFAULT_PRESERVE_RECENT_TOKENS = 20_000;
/**
 * Floors on what an automatic compaction leaves for messages. A fixed
 * overhead (system prompt, tool definitions) of ~20k tokens on a 92k budget
 * used to leave a target of one token, so one tool pair survived and the
 * model re-read every file after each compaction.
 */
export const MIN_PRESERVE_RECENT_TOKENS = 6_000;
/** The message target is at least this share of what fits under the trigger. */
export const MESSAGE_TARGET_FLOOR_RATIO = 0.35;
/** Longest the original request pinned in a summary can be. */
export const ORIGINAL_REQUEST_CHAR_LIMIT = 4_000;
/** The model-written progress section of one compaction. */
export const SUMMARY_PROGRESS_CHAR_LIMIT = 6_000;
/** Earlier sections are kept verbatim up to this size, then the oldest are condensed. */
export const SUMMARY_SECTIONS_CHAR_LIMIT = 12_000;
/** A condensed block of old sections. */
export const SUMMARY_CONDENSED_CHAR_LIMIT = 3_000;
/** Earlier sections never condensed: the newest ones. */
export const SUMMARY_SECTIONS_KEPT_VERBATIM = 2;
/** The whole summary message. */
export const SUMMARY_TEXT_CHAR_LIMIT = 24_000;
/** File lists in the summary show at most this many paths each. */
export const SUMMARY_FILES_LIMIT = 60;
/** Metadata layout written by this version (see CompactionSummaryMetadata). */
export const SUMMARY_SCHEMA_VERSION = 2;
// Headroom for the summarizer's output. Raised from 4096: models that reason
// by default can spend part of a tight budget on thinking and return no
// summary text at all, which skips compaction entirely. 8192 leaves room for a
// real summary even when some reasoning slips through.
export const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 8_192;
export const TOOL_RESULT_CHAR_LIMIT = 2_000;
export const FILE_CONTENT_CHAR_LIMIT = 2_000;
export const MIN_TRUNCATED_MESSAGE_TOKENS = 8;

export interface FileOperationSummary {
	readFiles: string[];
	modifiedFiles: string[];
}

/** What the summarizer's call cost, as the provider or catalog reported it. */
export interface CompactionSummarizerUsage {
	providerId: string;
	modelId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalCost?: number;
	/** How long the summarizer's call took. */
	durationMs?: number;
}

/**
 * One compaction's model-written progress note, kept verbatim in later
 * summaries instead of being summarized again (each round of that lost
 * detail and let the goal drift to the current sub-step).
 */
export interface CompactionSummarySection {
	/** 1-based; a condensed block keeps the number of its oldest section. */
	span: number;
	/** The iteration the compaction ran on, when known. */
	iteration?: number;
	/** Messages the section stands for. */
	foldedMessages: number;
	text: string;
	generatedAt: number;
	/** True for a block that condenses several older sections. */
	condensed?: boolean;
}

export interface CompactionSummaryMetadata {
	kind: "compaction_summary";
	displayRole: "system";
	userRunSpan: number;
	/**
	 * The newest model-written progress note (the "## Progress" section).
	 * Earlier versions stored the whole summary here; readers of old sidecars
	 * still get a text.
	 */
	summary: string;
	details: FileOperationSummary;
	tokensBefore: number;
	generatedAt: number;
	/** Kept with the summary so a reopened conversation can show the cost again. */
	summarizerUsage?: CompactionSummarizerUsage;
	/** SUMMARY_SCHEMA_VERSION; absent on summaries written before sections existed. */
	schemaVersion?: number;
	/** The newest typed prompt, pinned verbatim and reused by later compactions. */
	originalRequest?: string;
	/** Earlier progress notes, oldest first; the newest is `summary`. */
	sections?: CompactionSummarySection[];
	/** The latest task list the model wrote with update_todo_list, rendered. */
	todo?: string;
	/** The newest failed command or edit and the head of its result. */
	lastFailure?: string;
}

export type EstimateMessageTokens = (message: MessageWithMetadata) => number;

function isPositiveFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Resolve the model's usable prompt budget. A reported input limit is
 * authoritative but cannot exceed the context window. When the model only
 * reports a context window, retain a conservative margin for request overhead.
 */
export function resolveEffectiveMaxInputTokens(
	input: Pick<ModelInfo, "maxInputTokens" | "contextWindow">,
): number | undefined {
	const contextWindow = isPositiveFiniteNumber(input.contextWindow)
		? input.contextWindow
		: undefined;
	const maxInputTokens = isPositiveFiniteNumber(input.maxInputTokens)
		? input.maxInputTokens
		: undefined;

	if (maxInputTokens !== undefined) {
		return contextWindow === undefined
			? maxInputTokens
			: Math.min(maxInputTokens, contextWindow);
	}

	return contextWindow === undefined
		? undefined
		: contextWindow * CONTEXT_WINDOW_INPUT_RATIO;
}

export function truncateText(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

export function flattenToolResultContent(
	content: ToolResultContent["content"],
): string {
	const truncated = truncateToolResultContentForCompaction(content);
	if (typeof truncated === "string") {
		return truncated;
	}
	return truncated
		.map((block) => {
			switch (block.type) {
				case "text":
					return block.text;
				case "file":
					return `<file path="${block.path}">\n${block.content}\n</file>`;
				case "image":
					return `[image:${block.mediaType}]`;
				default:
					return "";
			}
		})
		.join("\n");
}

export function truncateToolResultContentForCompaction(
	content: ToolResultContent["content"],
): ToolResultContent["content"] {
	if (typeof content === "string") {
		return truncateText(content, TOOL_RESULT_CHAR_LIMIT);
	}
	return content.map((block) => {
		switch (block.type) {
			case "text":
				return {
					...block,
					text: truncateText(block.text, TOOL_RESULT_CHAR_LIMIT),
				};
			case "file":
				return {
					...block,
					content: truncateText(block.content, FILE_CONTENT_CHAR_LIMIT),
				};
			case "image":
				return block;
			default:
				return block;
		}
	});
}

export function formatToolInput(input: Record<string, unknown>): string {
	return Object.entries(input)
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
		.join(", ");
}

export function serializeMessage(message: MessageWithMetadata): string {
	if (typeof message.content === "string") {
		return `[${message.role === "user" ? "User" : "Bot"}]: ${message.content}`;
	}
	const lines: string[] = [];
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				lines.push(
					`[${message.role === "user" ? "User" : "Bot"}]: ${block.text}`,
				);
				break;
			case "thinking":
				lines.push(`[Bot thinking]: ${truncateText(block.thinking, 2_000)}`);
				break;
			case "redacted_thinking":
				lines.push("[Bot thinking]: [redacted]");
				break;
			case "tool_use":
				lines.push(
					`[Bot tool calls]: ${block.name}(${formatToolInput(block.input)})`,
				);
				break;
			case "tool_result":
				lines.push(`[Tool result]: ${flattenToolResultContent(block.content)}`);
				break;
			case "file":
				lines.push(
					`[${message.role === "user" ? "User" : "Bot"} file ${block.path}]: ${truncateText(block.content, FILE_CONTENT_CHAR_LIMIT)}`,
				);
				break;
			case "image":
				lines.push(
					`[${message.role === "user" ? "User" : "Bot"} image]: ${block.mediaType}`,
				);
				break;
			case "media":
				lines.push(
					`[Bot generated ${block.media.modality}]: ${block.media.mediaType}`,
				);
				break;
		}
	}
	return lines.join("\n");
}

export function serializeConversation(messages: MessageWithMetadata[]): string {
	return messages.map(serializeMessage).join("\n\n").trim();
}

export function createTokenEstimator(): EstimateMessageTokens {
	const cache = new WeakMap<object, number>();
	return (message) => {
		const ref = message as unknown as object;
		const cached = cache.get(ref);
		if (typeof cached === "number") {
			return cached;
		}
		// Images count at a fixed estimate, not as their base64 text, like the
		// request-level estimate the trigger compares against.
		const serialized = serializeForTokenEstimate(message);
		const value = estimateTokens(
			serialized.length > 0
				? serialized.length
				: serializeMessage(message).length,
		);
		cache.set(ref, value);
		return value;
	};
}

export function isCompactionSummaryMessage(
	message: MessageWithMetadata,
): boolean {
	return (
		(message.metadata as { kind?: string } | undefined)?.kind ===
		"compaction_summary"
	);
}

export function getCompactionSummaryMetadata(
	message: MessageWithMetadata,
): CompactionSummaryMetadata | undefined {
	if (!isCompactionSummaryMessage(message)) {
		return undefined;
	}
	const metadata = message.metadata as Record<string, unknown> | undefined;
	if (!metadata) {
		return undefined;
	}
	const details = metadata.details as Record<string, unknown> | undefined;
	return {
		kind: "compaction_summary",
		displayRole: "system",
		userRunSpan:
			typeof metadata.userRunSpan === "number" &&
			Number.isInteger(metadata.userRunSpan) &&
			metadata.userRunSpan >= 0
				? metadata.userRunSpan
				: 1,
		summary: String(metadata.summary ?? ""),
		details: {
			readFiles: Array.isArray(details?.readFiles)
				? details.readFiles
						.filter((value): value is string => typeof value === "string")
						.map((value) => value.trim())
						.filter((value) => value.length > 0)
				: [],
			modifiedFiles: Array.isArray(details?.modifiedFiles)
				? details.modifiedFiles
						.filter((value): value is string => typeof value === "string")
						.map((value) => value.trim())
						.filter((value) => value.length > 0)
				: [],
		},
		tokensBefore: Number(metadata.tokensBefore ?? 0),
		generatedAt: Number(metadata.generatedAt ?? 0),
		...(typeof metadata.schemaVersion === "number"
			? { schemaVersion: metadata.schemaVersion }
			: {}),
		...(typeof metadata.originalRequest === "string" &&
		metadata.originalRequest.trim()
			? { originalRequest: metadata.originalRequest }
			: {}),
		...(Array.isArray(metadata.sections)
			? { sections: parseSummarySections(metadata.sections) }
			: {}),
		...(typeof metadata.todo === "string" && metadata.todo.trim()
			? { todo: metadata.todo }
			: {}),
		...(typeof metadata.lastFailure === "string" && metadata.lastFailure.trim()
			? { lastFailure: metadata.lastFailure }
			: {}),
		...(metadata.summarizerUsage && typeof metadata.summarizerUsage === "object"
			? {
					summarizerUsage:
						metadata.summarizerUsage as CompactionSummarizerUsage,
				}
			: {}),
	};
}

function parseSummarySections(value: unknown[]): CompactionSummarySection[] {
	const sections: CompactionSummarySection[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const record = entry as Record<string, unknown>;
		if (typeof record.text !== "string" || !record.text.trim()) {
			continue;
		}
		sections.push({
			span:
				typeof record.span === "number" && Number.isFinite(record.span)
					? record.span
					: sections.length + 1,
			...(typeof record.iteration === "number"
				? { iteration: record.iteration }
				: {}),
			foldedMessages:
				typeof record.foldedMessages === "number" &&
				Number.isFinite(record.foldedMessages)
					? record.foldedMessages
					: 0,
			text: record.text,
			generatedAt:
				typeof record.generatedAt === "number" ? record.generatedAt : 0,
			...(record.condensed === true ? { condensed: true } : {}),
		});
	}
	return sections;
}

/**
 * The sections a new summary carries forward from the previous one: its
 * earlier sections plus its own progress note as the newest section. An old
 * summary without sections contributes its whole text as one section.
 */
export function carrySummarySections(
	previous: CompactionSummaryMetadata | undefined,
): CompactionSummarySection[] {
	if (!previous) {
		return [];
	}
	const sections = [...(previous.sections ?? [])];
	const text = previous.summary.trim();
	if (text) {
		sections.push({
			span: (sections.at(-1)?.span ?? 0) + 1,
			foldedMessages: 0,
			text,
			generatedAt: previous.generatedAt,
		});
	}
	return sections;
}

export function sectionsCharLength(
	sections: readonly CompactionSummarySection[],
): number {
	return sections.reduce((total, section) => total + section.text.length, 0);
}

/**
 * The sections to condense into one block when the earlier summaries have
 * grown past SUMMARY_SECTIONS_CHAR_LIMIT: all but the newest
 * SUMMARY_SECTIONS_KEPT_VERBATIM, or none when the rest are already within
 * the limit.
 */
export function selectSectionsToCondense(
	sections: readonly CompactionSummarySection[],
): { condense: CompactionSummarySection[]; keep: CompactionSummarySection[] } {
	if (
		sectionsCharLength(sections) <= SUMMARY_SECTIONS_CHAR_LIMIT ||
		sections.length <= SUMMARY_SECTIONS_KEPT_VERBATIM + 1
	) {
		return { condense: [], keep: [...sections] };
	}
	const split = sections.length - SUMMARY_SECTIONS_KEPT_VERBATIM;
	return {
		condense: sections.slice(0, split),
		keep: sections.slice(split),
	};
}

export function isToolResultOnlyUserMessage(
	message: MessageWithMetadata,
): boolean {
	if (message.role !== "user" || !Array.isArray(message.content)) {
		return false;
	}
	return (
		message.content.length > 0 &&
		message.content.every((block) => block.type === "tool_result")
	);
}

/**
 * A message the user typed. The runtime's own user-role messages (completion
 * reminders, loop notices, hook context, continuation prompts) carry
 * userRunSpan 0 or a synthetic kind and are not turn starts: they used to
 * move the cut and be taken for the newest request the summary's goal is
 * written from.
 */
export function isTurnStartMessage(message: MessageWithMetadata): boolean {
	return (
		message.role === "user" &&
		!isToolResultOnlyUserMessage(message) &&
		!isCompactionSummaryMessage(message) &&
		isUserRunMessage(message)
	);
}

export function findFirstUserMessageIndex(
	messages: MessageWithMetadata[],
): number {
	for (let index = 0; index < messages.length; index += 1) {
		if (isTurnStartMessage(messages[index])) {
			return index;
		}
	}
	return -1;
}

export function findLastTurnStartIndex(
	messages: MessageWithMetadata[],
): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (isTurnStartMessage(messages[index])) {
			return index;
		}
	}
	return 0;
}

/** Longest part of the newest typed prompt the summarizer is shown. */
const LATEST_REQUEST_CHAR_LIMIT = ORIGINAL_REQUEST_CHAR_LIMIT;

function typedMessageText(message: MessageWithMetadata): string {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("\n");
	// Without the editor-state and mode-notice blocks the host appends, and
	// without the <user_input mode> wrapper.
	return formatDisplayUserInput(text).trim();
}

/**
 * The text of the newest message the user typed, or undefined when there is
 * none. The summarizer is told to base the summary's goal on it, so an old
 * goal carried by a previous summary cannot outlive the request that replaced
 * it.
 */
export function extractLatestUserRequest(
	messages: MessageWithMetadata[],
): string | undefined {
	const index = findLastTurnStartIndex(messages);
	const message = messages[index];
	if (!message || !isTurnStartMessage(message)) {
		return undefined;
	}
	const trimmed = typedMessageText(message);
	return trimmed ? truncateText(trimmed, LATEST_REQUEST_CHAR_LIMIT) : undefined;
}

/**
 * The request the summary's goal is written from: the newest typed prompt in
 * `messages`, or, once that prompt has itself been folded into a summary (a
 * single task followed by a long tool loop), the request the previous summary
 * pinned. Without the fallback every later summary had only the "may be
 * stale" previous goal to go on, and the goal narrowed to the current step.
 */
export function extractOriginalRequest(
	messages: MessageWithMetadata[],
): string | undefined {
	const latest = extractLatestUserRequest(messages);
	if (latest) {
		return latest;
	}
	const summaryIndex = findLatestSummaryIndex(messages);
	if (summaryIndex < 0) {
		return undefined;
	}
	const pinned = getCompactionSummaryMetadata(
		messages[summaryIndex],
	)?.originalRequest?.trim();
	return pinned ? truncateText(pinned, LATEST_REQUEST_CHAR_LIMIT) : undefined;
}

export function findLastAssistantIndex(
	messages: MessageWithMetadata[],
): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === "assistant") {
			return index;
		}
	}
	return -1;
}

export function findLatestSummaryIndex(
	messages: MessageWithMetadata[],
): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (isCompactionSummaryMessage(messages[index])) {
			return index;
		}
	}
	return -1;
}

/**
 * A cut boundary is safe when starting the preserved tail there cannot
 * orphan half of a tool_use/tool_result pair. Typed user turns qualify,
 * and so do assistant messages: an assistant's tool_use keeps its results
 * in the user message that follows it, so both halves stay on the same
 * side of the cut. A tool_result-only user message is never safe — its
 * matching tool_use sits in the preceding assistant message and would be
 * folded into the summary, leaving an orphaned tool_result the provider
 * rejects.
 */
function isSafeCutBoundary(message: MessageWithMetadata): boolean {
	return message.role === "assistant" || isTurnStartMessage(message);
}

export function findCutIndex(
	messages: MessageWithMetadata[],
	preserveRecentTokens: number,
	estimateMessageTokens: EstimateMessageTokens,
): number {
	let total = 0;
	let candidate = messages.length;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		total += estimateMessageTokens(messages[index]);
		candidate = index;
		if (total >= preserveRecentTokens) {
			break;
		}
	}

	if (candidate <= 0) {
		return 0;
	}

	// Never summarize away the latest typed user prompt: when one exists
	// past index 0, the cut stays at or before it so that whole turn
	// survives verbatim. Transcripts without a later typed turn (a single
	// task followed by one long tool loop, or a projection that starts
	// with a compaction summary) still cut at the token-budget candidate.
	const lastTurnStartIndex = findLastTurnStartIndex(messages);
	let cut =
		lastTurnStartIndex > 0
			? Math.min(candidate, lastTurnStartIndex)
			: candidate;
	while (cut > 0 && !isSafeCutBoundary(messages[cut])) {
		cut -= 1;
	}
	return cut;
}

export function collectPaths(value: unknown): string[] {
	if (typeof value === "string" && value.trim().length > 0) {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap((item) => collectPaths(item));
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const paths: string[] = [];
		for (const key of [
			"path",
			"file_path",
			"target_file",
			"new_file_path",
			"old_file_path",
		]) {
			paths.push(...collectPaths(record[key]));
		}
		if (Array.isArray(record.files)) {
			for (const item of record.files) {
				if (item && typeof item === "object") {
					paths.push(...collectPaths((item as Record<string, unknown>).path));
				}
			}
		}
		if (Array.isArray(record.file_paths)) {
			paths.push(...collectPaths(record.file_paths));
		}
		return paths;
	}
	return [];
}

/**
 * The key two spellings of one file share: Windows paths (a drive letter, or
 * any path on win32) compare without case and with one separator, so
 * `D:\\x\\a.h` and `d:/x/a.h` are one entry. Other paths compare as they are.
 */
function filePathKey(path: string): string {
	const windowsLike =
		/^[a-z]:[\\/]/i.test(path) || process.platform === "win32";
	return windowsLike ? path.toLowerCase().replace(/\//g, "\\") : path;
}

export function mergeUnique(base: string[], next: Iterable<string>): string[] {
	const byKey = new Map<string, string>();
	for (const value of base) {
		const trimmed = value.trim();
		if (trimmed && !byKey.has(filePathKey(trimmed))) {
			byKey.set(filePathKey(trimmed), trimmed);
		}
	}
	for (const value of next) {
		const trimmed = value.trim();
		if (!trimmed) {
			continue;
		}
		const key = filePathKey(trimmed);
		if (!byKey.has(key)) {
			byKey.set(key, trimmed);
		}
	}
	return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

export function extractFileOps(
	messages: MessageWithMetadata[],
): FileOperationSummary {
	let readFiles: string[] = [];
	let modifiedFiles: string[] = [];
	for (const message of messages) {
		const summaryMetadata = getCompactionSummaryMetadata(message);
		if (summaryMetadata) {
			readFiles = mergeUnique(readFiles, summaryMetadata.details.readFiles);
			modifiedFiles = mergeUnique(
				modifiedFiles,
				summaryMetadata.details.modifiedFiles,
			);
			continue;
		}
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "file") {
				readFiles = mergeUnique(readFiles, [block.path]);
				continue;
			}
			if (block.type !== "tool_use") {
				continue;
			}
			const paths = collectPaths(block.input);
			if (block.name === "read_files") {
				readFiles = mergeUnique(readFiles, paths);
				continue;
			}
			if (block.name === "editor" || block.name === "apply_patch") {
				modifiedFiles = mergeUnique(modifiedFiles, paths);
			}
		}
	}
	return { readFiles, modifiedFiles };
}

/** Commands longer than this are truncated in dropped-work summaries. */
export const COMMAND_SUMMARY_CHAR_LIMIT = 100;

/**
 * Compact record of the tool work performed inside a span of dropped
 * messages: which files were read and edited (with line ranges when
 * known) and which commands ran.
 */
export interface ToolActivitySummary {
	readFiles: string[];
	editedFiles: string[];
	commands: string[];
}

export function hasToolActivity(summary: ToolActivitySummary): boolean {
	return (
		summary.readFiles.length > 0 ||
		summary.editedFiles.length > 0 ||
		summary.commands.length > 0
	);
}

function pushUniqueEntry(list: string[], value: string): void {
	const trimmed = value.trim();
	if (trimmed && !list.includes(trimmed)) {
		list.push(trimmed);
	}
}

function truncateCommandForSummary(command: string): string {
	if (command.length <= COMMAND_SUMMARY_CHAR_LIMIT) {
		return command;
	}
	return `${command.slice(0, COMMAND_SUMMARY_CHAR_LIMIT)}...`;
}

function formatReadFileEntry(
	record: Record<string, unknown>,
): string | undefined {
	const path = typeof record.path === "string" ? record.path.trim() : "";
	if (!path) {
		return undefined;
	}
	const start = record.start_line;
	const end = record.end_line;
	if (typeof start === "number" && typeof end === "number") {
		return `${path}:${start}-${end}`;
	}
	return path;
}

/**
 * Pull the edited line range out of an editor tool result. Editor results
 * embed a numbered diff (`-467: ...` / `+467: ...`), usually inside a
 * JSON-encoded payload's `result` field; the range is the min/max line
 * number seen. Returns undefined when no diff line numbers are found.
 */
function extractDiffLineRange(
	content: ToolResultContent["content"],
): { start: number; end: number } | undefined {
	let text =
		typeof content === "string"
			? content
			: content
					.map((block) =>
						block.type === "text"
							? block.text
							: block.type === "file"
								? block.content
								: "",
					)
					.join("\n");
	try {
		const parsed = JSON.parse(text) as { result?: unknown };
		if (parsed && typeof parsed.result === "string") {
			text = parsed.result;
		}
	} catch {
		// Not JSON-encoded; scan the raw text.
	}
	let start = Number.POSITIVE_INFINITY;
	let end = Number.NEGATIVE_INFINITY;
	for (const match of text.matchAll(/(?:^|\n|\\n)[-+](\d+): /g)) {
		const line = Number(match[1]);
		if (!Number.isFinite(line)) {
			continue;
		}
		start = Math.min(start, line);
		end = Math.max(end, line);
	}
	return start <= end ? { start, end } : undefined;
}

/**
 * Summarize the tool work inside a span of messages that compaction is
 * dropping. Read ranges come from read_files inputs; edited ranges come
 * from the numbered diff in the matching editor result when present.
 */
export function summarizeToolActivity(
	messages: MessageWithMetadata[],
): ToolActivitySummary {
	const readFiles: string[] = [];
	const editedFiles: string[] = [];
	const commands: string[] = [];
	const editorPathsByToolUseId = new Map<string, string>();
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "tool_use") {
				const input = (block.input ?? {}) as Record<string, unknown>;
				if (block.name === "read_files") {
					if (Array.isArray(input.files)) {
						for (const file of input.files) {
							if (file && typeof file === "object") {
								const entry = formatReadFileEntry(
									file as Record<string, unknown>,
								);
								if (entry) {
									pushUniqueEntry(readFiles, entry);
								}
							}
						}
					} else {
						for (const path of collectPaths(input)) {
							pushUniqueEntry(readFiles, path);
						}
					}
					continue;
				}
				if (block.name === "editor" || block.name === "apply_patch") {
					const path = collectPaths(input)[0];
					if (path) {
						editorPathsByToolUseId.set(block.id, path);
					}
					continue;
				}
				if (block.name === "run_commands") {
					const commandList = Array.isArray(input.commands)
						? input.commands
						: [];
					for (const command of commandList) {
						if (typeof command === "string" && command.trim()) {
							pushUniqueEntry(
								commands,
								truncateCommandForSummary(command.trim()),
							);
						}
					}
				}
				continue;
			}
			if (block.type === "tool_result") {
				const path = editorPathsByToolUseId.get(block.tool_use_id);
				if (!path) {
					continue;
				}
				const range = extractDiffLineRange(block.content);
				pushUniqueEntry(
					editedFiles,
					range ? `${path}:${range.start}-${range.end}` : path,
				);
				editorPathsByToolUseId.delete(block.tool_use_id);
			}
		}
	}
	// Editor calls whose results fell outside the span still count as edits.
	for (const path of editorPathsByToolUseId.values()) {
		pushUniqueEntry(editedFiles, path);
	}
	return { readFiles, editedFiles, commands };
}

export function formatToolActivitySummary(
	summary: ToolActivitySummary,
): string {
	return [
		`Files read:\n${summary.readFiles.join("\n")}`,
		`Files edited:\n${summary.editedFiles.join("\n")}`,
		`Commands ran:\n${summary.commands.join("\n")}`,
	].join("\n\n");
}

function renderPathList(paths: string[]): string {
	if (paths.length === 0) {
		return "- none";
	}
	const shown = paths.slice(0, SUMMARY_FILES_LIMIT).map((path) => `- ${path}`);
	if (paths.length > SUMMARY_FILES_LIMIT) {
		shown.push(`- ... and ${paths.length - SUMMARY_FILES_LIMIT} more`);
	}
	return shown.join("\n");
}

export function renderFilesSection(fileOps: FileOperationSummary): string {
	return `## Files\nRead:\n${renderPathList(fileOps.readFiles)}\nModified:\n${renderPathList(fileOps.modifiedFiles)}`;
}

/**
 * The model-written part of a summary without the sections the host renders
 * itself (`## Files`, `## Goal`, `## Original request`): a model that writes
 * them anyway would duplicate the pinned request and the file lists.
 */
export function stripHostRenderedSections(summary: string): string {
	const lines = summary.split("\n");
	const kept: string[] = [];
	let skipping = false;
	for (const line of lines) {
		const heading = /^\s*#{1,3}\s+(.+?)\s*$/.exec(line);
		if (heading) {
			const title = heading[1].toLowerCase();
			skipping =
				/^(files|goal|original request|task list|last failure|earlier (summaries|work))\b/.test(
					title,
				);
			if (skipping) {
				continue;
			}
		}
		if (!skipping) {
			kept.push(line);
		}
	}
	return kept.join("\n").trim();
}

export function ensureFilesSection(
	summary: string,
	fileOps: FileOperationSummary,
): string {
	if (/^## Files$/im.test(summary)) {
		return summary.trim();
	}
	return `${summary.trim()}\n\n${renderFilesSection(fileOps)}`.trim();
}

export function buildSummaryRequest(options: {
	/** Older progress notes, kept for reference; the model does not rewrite them. */
	previousSummary?: string;
	conversationText: string;
	fileOps: FileOperationSummary;
	/** The newest message the user typed, even when it is outside the span. */
	latestUserRequest?: string;
	/** The model's own task list, as last written with update_todo_list. */
	todo?: string;
	/** The newest failed command or edit in the span, with the head of its result. */
	lastFailure?: string;
}): string {
	const parts: string[] = [
		`Summarize the conversation below for continuation. Be concise and factual. Write only these three sections, about the conversation below (the newest span of work); earlier spans are already summarized under "Earlier summaries" and must not be restated.

## State
- Done: only steps whose result you can see in the conversation (a tool result, a passing run, an edited file). Anything an earlier summary calls done that this conversation does not show goes under "Unverified" instead.
- In Progress: current work
- Blocked: blockers or open questions, including failing tests or builds that are still failing
- Unverified: claims you could not confirm (omit if none)

## Highlights
Key technical choices, findings, and exact error messages still to fix (omit if none).

## Next
Immediate next steps towards the original request, in order.

Do not write a Goal, Files or Task list section, and do not list file paths: the host adds the original request, the task list and the files itself.`,
	];

	if (options.latestUserRequest?.trim()) {
		parts.push(
			`Original request (the goal; later user messages win):\n${options.latestUserRequest.trim()}`,
		);
	}

	if (options.todo?.trim()) {
		parts.push(
			`Task list (as the assistant last wrote it):\n${options.todo.trim()}`,
		);
	}

	if (options.lastFailure?.trim()) {
		parts.push(`Newest failed command or edit:\n${options.lastFailure.trim()}`);
	}

	if (options.previousSummary?.trim()) {
		parts.push(
			`Earlier summaries (for reference; do not restate them):\n${options.previousSummary.trim()}`,
		);
	}

	parts.push(`Conversation:\n${options.conversationText || "(empty)"}`);

	return parts.join("\n\n");
}

/** The request that condenses old summary sections into one block. */
export function buildCondenseRequest(options: {
	sections: readonly CompactionSummarySection[];
	originalRequest?: string;
}): string {
	const parts = [
		`Condense these earlier progress notes of a coding session into one note of at most ${SUMMARY_CONDENSED_CHAR_LIMIT} characters. Keep: what was done and verified, decisions and their reasons, exact error messages that were still unresolved, and anything marked Unverified. Drop repetition and steps that later notes superseded. Write plain markdown bullets, no headings.`,
	];
	if (options.originalRequest?.trim()) {
		parts.push(`Original request:\n${options.originalRequest.trim()}`);
	}
	parts.push(
		`Notes, oldest first:\n${options.sections
			.map((section) => `### Span ${section.span}\n${section.text.trim()}`)
			.join("\n\n")}`,
	);
	return parts.join("\n\n");
}

/**
 * The summarizer output budget is a cap, not a target: reasoning models need
 * headroom beyond their thinking output or no summary text ever arrives and
 * compaction is skipped. An explicit configuration wins as-is; otherwise the
 * default applies, with model metadata (`maxTokens` is reported capability,
 * not a product default) only ever lowering it.
 */
function resolveSummaryMaxOutputTokens(config: ProviderConfig): number {
	if (isPositiveFiniteNumber(config.maxOutputTokens)) {
		return Math.floor(config.maxOutputTokens);
	}
	const modelMaxTokens =
		config.modelInfo?.maxTokens ??
		config.knownModels?.[config.modelId]?.maxTokens;
	if (isPositiveFiniteNumber(modelMaxTokens)) {
		return Math.min(
			DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
			Math.floor(modelMaxTokens),
		);
	}
	return DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS;
}

export function resolveSummarizerConfig(options: {
	activeProviderConfig: ProviderConfig;
	summarizer?: CoreCompactionSummarizerConfig;
}): ProviderConfig {
	const summarizer = options.summarizer;
	const withSummarizerDefaults = (config: ProviderConfig): ProviderConfig => {
		if (config.providerId === "openai-codex") {
			const { maxOutputTokens: _maxOutputTokens, ...rest } = config;
			return {
				...rest,
				thinking: false,
			};
		}
		return {
			...config,
			maxOutputTokens: resolveSummaryMaxOutputTokens(config),
			thinking: false,
		};
	};
	if (!summarizer) {
		return withSummarizerDefaults(options.activeProviderConfig);
	}
	const baseProviderConfig =
		summarizer.providerConfig?.providerId === summarizer.providerId
			? summarizer.providerConfig
			: undefined;
	return withSummarizerDefaults({
		...(baseProviderConfig ?? {}),
		providerId: summarizer.providerId,
		modelId: summarizer.modelId,
		apiKey: summarizer.apiKey ?? baseProviderConfig?.apiKey,
		baseUrl: summarizer.baseUrl ?? baseProviderConfig?.baseUrl,
		headers: summarizer.headers ?? baseProviderConfig?.headers,
		modelInfo: summarizer.modelInfo ?? baseProviderConfig?.modelInfo,
		knownModels: summarizer.knownModels ?? baseProviderConfig?.knownModels,
		maxOutputTokens:
			summarizer.maxOutputTokens ?? baseProviderConfig?.maxOutputTokens,
	});
}

function renderSectionHeading(section: CompactionSummarySection): string {
	const where =
		section.iteration !== undefined ? `iteration ${section.iteration}` : "";
	const size =
		section.foldedMessages > 0 ? `${section.foldedMessages} messages` : "";
	const detail = [where, size].filter(Boolean).join(", ");
	const label = section.condensed
		? `Spans up to ${section.span} (condensed)`
		: `Span ${section.span}`;
	return detail ? `### ${label} (${detail})` : `### ${label}`;
}

/**
 * The text of a summary message. Everything but `progress` is rendered by
 * code: the pinned request, the task list, the earlier sections verbatim,
 * the newest failure and the file lists. The whole text is capped.
 */
export function renderSummaryText(options: {
	/** Rendered only when the prompt itself is no longer in the request. */
	originalRequest?: string;
	todo?: string;
	progress: string;
	sections: readonly CompactionSummarySection[];
	lastFailure?: string;
	fileOps: FileOperationSummary;
}): string {
	const parts: string[] = ["Context summary:"];
	if (options.originalRequest?.trim()) {
		parts.push(
			`## Original request\n${truncateText(options.originalRequest.trim(), ORIGINAL_REQUEST_CHAR_LIMIT)}`,
		);
	}
	if (options.todo?.trim()) {
		parts.push(`## Task list\n${options.todo.trim()}`);
	}
	parts.push(
		`## Progress\n${truncateText(options.progress.trim(), SUMMARY_PROGRESS_CHAR_LIMIT)}`,
	);
	if (options.sections.length > 0) {
		parts.push(
			`## Earlier summaries\n${options.sections
				.map(
					(section) =>
						`${renderSectionHeading(section)}\n${section.text.trim()}`,
				)
				.join("\n\n")}`,
		);
	}
	if (options.lastFailure?.trim()) {
		parts.push(`## Last failure\n${options.lastFailure.trim()}`);
	}
	parts.push(renderFilesSection(options.fileOps));
	parts.push(
		"The user's messages after this summary take precedence over the request above.",
	);
	const text = parts.join("\n\n");
	return text.length > SUMMARY_TEXT_CHAR_LIMIT
		? `${truncateText(text, SUMMARY_TEXT_CHAR_LIMIT - 120)}\n\nThe user's messages after this summary take precedence over the request above.`
		: text;
}

export function buildSummaryMessage(options: {
	/** The newest model-written progress note. */
	summary: string;
	fileOps: FileOperationSummary;
	tokensBefore: number;
	userRunSpan: number;
	summarizerUsage?: CompactionSummarizerUsage;
	originalRequest?: string;
	/**
	 * Whether the request is written into the text. While the typed prompt
	 * is still in the preserved tail it is not repeated; the metadata keeps
	 * it for the compaction that folds the prompt.
	 */
	renderOriginalRequest?: boolean;
	sections?: CompactionSummarySection[];
	todo?: string;
	lastFailure?: string;
}): MessageWithMetadata {
	const sections = options.sections ?? [];
	const progress = truncateText(
		options.summary.trim(),
		SUMMARY_PROGRESS_CHAR_LIMIT,
	);
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: renderSummaryText({
					originalRequest:
						options.renderOriginalRequest === false
							? undefined
							: options.originalRequest,
					todo: options.todo,
					progress,
					sections,
					lastFailure: options.lastFailure,
					fileOps: options.fileOps,
				}),
			},
		],
		metadata: {
			kind: "compaction_summary",
			displayRole: "system",
			userRunSpan: options.userRunSpan,
			summary: progress,
			details: options.fileOps,
			tokensBefore: options.tokensBefore,
			generatedAt: Date.now(),
			schemaVersion: SUMMARY_SCHEMA_VERSION,
			...(options.originalRequest?.trim()
				? { originalRequest: options.originalRequest.trim() }
				: {}),
			...(sections.length > 0 ? { sections } : {}),
			...(options.todo?.trim() ? { todo: options.todo.trim() } : {}),
			...(options.lastFailure?.trim()
				? { lastFailure: options.lastFailure.trim() }
				: {}),
			...(options.summarizerUsage
				? { summarizerUsage: options.summarizerUsage }
				: {}),
		} satisfies CompactionSummaryMetadata,
	};
}

/**
 * Copies of `messages` with tool results and file blocks cut to what the
 * summarizer is sent (serializeMessage applies the same limits), so the
 * summary input budget is sized on that text rather than on the full
 * results. Messages without such blocks are returned as they are.
 */
export function truncateToolResultsForSummary(
	messages: readonly MessageWithMetadata[],
): MessageWithMetadata[] {
	return messages.map((message) => {
		if (!Array.isArray(message.content)) {
			return message;
		}
		let changed = false;
		const content = message.content.map((block) => {
			if (block.type === "tool_result") {
				const truncated = truncateToolResultContentForCompaction(block.content);
				if (truncated !== block.content) {
					changed = true;
					return { ...block, content: truncated };
				}
				return block;
			}
			if (
				block.type === "file" &&
				block.content.length > FILE_CONTENT_CHAR_LIMIT
			) {
				changed = true;
				return {
					...block,
					content: truncateText(block.content, FILE_CONTENT_CHAR_LIMIT),
				};
			}
			return block;
		});
		return changed ? { ...message, content } : message;
	});
}
