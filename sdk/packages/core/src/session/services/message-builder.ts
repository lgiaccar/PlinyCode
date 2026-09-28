/**
 * API-safe message builder for provider payloads.
 *
 * @see PLAN.md §3.1 — moved from `packages/agents/src/context/message-builder.ts`.
 * @see PLAN.md §3.2.3 — public surface of `MessageBuilder`.
 *
 * Walks the conversation to produce provider-ready messages, handling
 * tool-result truncation and outdated-file-content rewrite for compaction.
 * Per-instance caches make this host state.
 */

import {
	type ContentBlock,
	type MediaBudgetOptions,
	type Message,
	normalizeUserInput,
	type ResolvedMediaBudget,
	resolveMediaBudget,
	type ToolResultContent,
} from "@plinycode/shared";
import {
	isBinaryContentLike,
	isStructuredToolResultEntry,
} from "./messages/content-entries";
import { applyMediaBudget } from "./messages/media-budget";
import { addMissingToolResults } from "./messages/missing-tool-results";
import {
	countOutdatedImageEntries,
	replaceOutdatedReadContent,
} from "./messages/outdated-reads";
import {
	extractLocatorFromResultEntry,
	extractLocatorsFromReadToolInput,
	extractReadLocatorsFromToolResultContent,
	isFullFileRead,
	isReadTool,
	type ReadLocator,
	toReadLocatorKey,
} from "./messages/read-locators";
import {
	cloneContentBlockForMutation,
	collectTruncationCandidates,
	countMessageTextBytes,
	REPEATED_TOOL_CALL_MARKUP_THRESHOLD,
	TOOL_CALL_MARKUP_PATTERN,
	TRUNCATE_ASSISTANT_TEXT_MARKER,
	TRUNCATE_ASSISTANT_TOOL_MARKUP_MARKER,
	TRUNCATE_MARKER_DEFAULT,
	truncateMiddleByChars,
	truncateMiddleToBytes,
	utf8ByteLength,
} from "./messages/truncation";

export const DEFAULT_MAX_TOOL_RESULT_CHARS = 8_000;
export const DEFAULT_MAX_FILE_CONTENT_CHARS = 50_000;
// The aggregate budget intentionally stays far above what the per-result cap
// usually produces: budget truncation rewrites bytes mid-transcript, which
// invalidates provider prefix caches from the first rewritten block onward,
// so it must remain a rare overflow valve rather than the steady state.
export const DEFAULT_MAX_TOTAL_TEXT_BYTES = 6_000_000;
export const DEFAULT_MAX_ASSISTANT_TEXT_CHARS = 200_000;
export const DEFAULT_MAX_ASSISTANT_TOOL_MARKUP_CHARS = 12_000;
// Batch stale-read rewrites to avoid breaking provider prefix caches on every re-read.
// 64KB is roughly 8 provider-capped read results; set to 0 for eager rewriting.
export const DEFAULT_MIN_OUTDATED_REWRITE_BYTES = 65_536;

export const MESSAGE_BUILDER_LIMIT_ENV = {
	maxToolResultChars: "CLINE_MESSAGE_BUILDER_MAX_TOOL_RESULT_CHARS",
	maxTotalTextBytes: "CLINE_MESSAGE_BUILDER_MAX_TOTAL_TEXT_BYTES",
	minOutdatedRewriteBytes: "CLINE_MESSAGE_BUILDER_MIN_OUTDATED_REWRITE_BYTES",
} as const;

export interface MessageBuilderOptions {
	maxToolResultChars?: number;
	maxFileContentChars?: number;
	maxTotalTextBytes?: number;
	mediaBudget?: MediaBudgetOptions;
	maxAssistantTextChars?: number;
	maxAssistantToolMarkupChars?: number;
	minOutdatedRewriteBytes?: number;
}

export function getMessageBuilderOptionsFromEnv(
	env: Record<string, string | undefined> = process.env,
): MessageBuilderOptions {
	// Size caps reject zero/negative overrides; stale-read batching accepts 0
	// for eager mode and "disable"/"Infinity" for rollback.
	return {
		maxToolResultChars: parsePositiveIntegerEnv(
			env[MESSAGE_BUILDER_LIMIT_ENV.maxToolResultChars],
		),
		maxTotalTextBytes: parsePositiveIntegerEnv(
			env[MESSAGE_BUILDER_LIMIT_ENV.maxTotalTextBytes],
		),
		minOutdatedRewriteBytes: parseNonNegativeLimitEnv(
			env[MESSAGE_BUILDER_LIMIT_ENV.minOutdatedRewriteBytes],
		),
	};
}

/**
 * Builds an API-safe message copy without mutating original conversation history.
 */
export class MessageBuilder {
	private indexedMessageCount = 0;
	private indexedTailRef: Message | undefined;
	private readonly toolNameByIdCache = new Map<string, string>();
	private readonly readLocatorsByToolUseIdCache = new Map<
		string,
		ReadLocator[]
	>();
	private readonly latestReadToolUseByLocatorCache = new Map<string, string>();
	private readonly latestFullContentOwnerByPathCache = new Map<
		string,
		string
	>();
	private readResultLocatorCache = new WeakMap<object, ReadLocator[]>();
	private readonly maxToolResultChars: number;
	private readonly maxFileContentChars: number;
	private readonly maxTotalTextBytes: number;
	private readonly mediaBudget: MediaBudgetOptions;
	private readonly maxAssistantTextChars: number;
	private readonly maxAssistantToolMarkupChars: number;
	private readonly minOutdatedRewriteBytes: number;
	// Sticky rewrite decisions. Kept across resetIndexes because production
	// rebuilds fresh Message objects; entries are revalidated/pruned per build.
	private readonly committedOutdatedRewrites = new Map<string, Set<string>>();

	constructor(options: MessageBuilderOptions = {}) {
		this.maxToolResultChars = normalizePositiveLimit(
			options.maxToolResultChars,
			DEFAULT_MAX_TOOL_RESULT_CHARS,
		);
		this.maxFileContentChars = normalizePositiveLimit(
			options.maxFileContentChars,
			DEFAULT_MAX_FILE_CONTENT_CHARS,
		);
		this.maxTotalTextBytes = normalizePositiveLimit(
			options.maxTotalTextBytes,
			DEFAULT_MAX_TOTAL_TEXT_BYTES,
		);
		this.mediaBudget = options.mediaBudget ?? {};
		this.maxAssistantTextChars = normalizePositiveLimit(
			options.maxAssistantTextChars,
			DEFAULT_MAX_ASSISTANT_TEXT_CHARS,
		);
		this.maxAssistantToolMarkupChars = normalizePositiveLimit(
			options.maxAssistantToolMarkupChars,
			DEFAULT_MAX_ASSISTANT_TOOL_MARKUP_CHARS,
		);
		this.minOutdatedRewriteBytes = normalizeNonNegativeLimit(
			options.minOutdatedRewriteBytes,
			DEFAULT_MIN_OUTDATED_REWRITE_BYTES,
		);
	}

	resetConversationState(): void {
		this.resetIndexes();
		this.committedOutdatedRewrites.clear();
	}

	buildForApi(messages: Message[]): Message[] {
		this.reindex(messages);
		this.commitOutdatedRewrites(messages);
		const repairedMessages = addMissingToolResults(messages);

		const prepared = repairedMessages.map((message) => {
			if (!Array.isArray(message.content)) {
				if (message.role === "user" && typeof message.content === "string") {
					const normalized = normalizeUserInput(message.content);
					if (normalized !== message.content) {
						return { ...message, content: normalized };
					}
				}
				if (
					message.role === "assistant" &&
					typeof message.content === "string"
				) {
					const truncated = this.truncateAssistantText(message.content);
					if (truncated !== message.content) {
						return { ...message, content: truncated };
					}
				}
				return message;
			}

			let changed = false;
			const content = message.content.map((block) => {
				const next = this.transformBlock(block, message.role);
				if (next !== block) {
					changed = true;
				}
				return next;
			});

			return changed ? { ...message, content } : message;
		});

		const mediaLimited = applyMediaBudget(prepared, this.resolveMediaBudget());
		return this.truncateToTotalTextBudget(mediaLimited);
	}

	private transformBlock(
		block: ContentBlock,
		role: Message["role"],
	): ContentBlock {
		if (
			role === "user" &&
			block.type === "text" &&
			typeof block.text === "string"
		) {
			const normalized = normalizeUserInput(block.text);
			if (normalized !== block.text) {
				return { ...block, text: normalized };
			}
			return block;
		}

		if (
			role === "assistant" &&
			block.type === "text" &&
			typeof block.text === "string"
		) {
			const truncated = this.truncateAssistantText(block.text);
			return truncated === block.text ? block : { ...block, text: truncated };
		}

		if (block.type === "file") {
			// Top-level file blocks are user attachments, not tool output; they
			// get their own (looser) cap so the aggressive tool-result limit
			// does not mutilate content the user explicitly supplied.
			const truncated = truncateMiddleByChars(
				block.content,
				this.maxFileContentChars,
				TRUNCATE_MARKER_DEFAULT,
			);
			return truncated === block.content
				? block
				: { ...block, content: truncated };
		}

		if (block.type !== "tool_result") {
			return block;
		}

		const toolName = this.resolveToolName(block);
		let nextContent = block.content;

		if (isReadTool(toolName) && block.is_error !== true) {
			const committed = this.committedOutdatedRewrites.get(block.tool_use_id);
			if (committed && committed.size > 0) {
				const locators = this.getReadLocators(block);
				const outdated = locators.filter(
					(locator) =>
						committed.has(toReadLocatorKey(locator)) &&
						this.isOutdatedReadLocator(locator, block.tool_use_id),
				);
				if (outdated.length > 0) {
					nextContent = replaceOutdatedReadContent(nextContent, outdated);
				}
			}
		}

		// Truncation is default-on for every tool result: MCP and custom SDK
		// tools produce payloads just as large as the built-in ones, and any
		// allowlist gate silently exempts them.
		nextContent = this.truncateToolResultContent(nextContent);

		return nextContent === block.content
			? block
			: { ...block, content: nextContent };
	}

	private reindex(messages: Message[]): void {
		const tailUnchanged =
			this.indexedMessageCount === 0 ||
			(messages.length >= this.indexedMessageCount &&
				messages[this.indexedMessageCount - 1] === this.indexedTailRef);
		if (messages.length < this.indexedMessageCount || !tailUnchanged) {
			this.resetIndexes();
		}

		for (let i = this.indexedMessageCount; i < messages.length; i++) {
			const message = messages[i];
			if (!Array.isArray(message.content)) {
				continue;
			}

			for (let j = 0; j < message.content.length; j++) {
				const block = message.content[j];
				if (block.type === "file") {
					this.latestFullContentOwnerByPathCache.set(
						block.path,
						`file:${i}:${j}`,
					);
				} else if (block.type === "tool_use") {
					const normalizedName = block.name.toLowerCase();
					this.toolNameByIdCache.set(block.id, normalizedName);
					if (isReadTool(normalizedName)) {
						const locators = extractLocatorsFromReadToolInput(block.input);
						if (locators.length > 0) {
							this.readLocatorsByToolUseIdCache.set(block.id, locators);
						}
					}
				} else if (block.type === "tool_result") {
					const toolName = this.resolveToolName(block);
					if (!isReadTool(toolName) || block.is_error === true) {
						continue;
					}
					const locators = this.getReadLocators(block);
					for (const locator of locators) {
						this.latestReadToolUseByLocatorCache.set(
							toReadLocatorKey(locator),
							block.tool_use_id,
						);
						if (isFullFileRead(locator)) {
							this.latestFullContentOwnerByPathCache.set(
								locator.path,
								block.tool_use_id,
							);
						}
					}
				}
			}
		}
		this.indexedMessageCount = messages.length;
		this.indexedTailRef =
			messages.length > 0 ? messages[messages.length - 1] : undefined;
	}

	/** Commits pending stale-read rewrites once reclaimable bytes cross the threshold. */
	private commitOutdatedRewrites(messages: Message[]): void {
		const pending = new Map<string, Set<string>>();
		const seenToolUseIds = new Set<string>();
		let pendingBytes = 0;

		for (const message of messages) {
			if (!Array.isArray(message.content)) {
				continue;
			}
			for (const block of message.content) {
				if (block.type !== "tool_result" || block.is_error === true) {
					continue;
				}
				const toolName = this.resolveToolName(block);
				if (!isReadTool(toolName)) {
					continue;
				}
				seenToolUseIds.add(block.tool_use_id);
				const committed = this.committedOutdatedRewrites.get(block.tool_use_id);
				const newKeys = new Set<string>();
				const validKeys = new Set<string>();
				for (const locator of this.getReadLocators(block)) {
					const key = toReadLocatorKey(locator);
					if (!this.isOutdatedReadLocator(locator, block.tool_use_id)) {
						continue;
					}
					validKeys.add(key);
					if (!committed?.has(key)) {
						newKeys.add(key);
					}
				}
				// Rollback can make a committed locator current again.
				if (committed) {
					for (const key of committed) {
						if (!validKeys.has(key)) {
							committed.delete(key);
						}
					}
					if (committed.size === 0) {
						this.committedOutdatedRewrites.delete(block.tool_use_id);
					}
				}
				if (newKeys.size === 0) {
					continue;
				}
				let keys = pending.get(block.tool_use_id);
				if (!keys) {
					keys = new Set<string>();
					pending.set(block.tool_use_id, keys);
				}
				for (const key of newKeys) {
					keys.add(key);
				}
				// Attribute provider-bound bytes to the newly-stale locators, not
				// raw history bytes or the whole block.
				pendingBytes += this.estimateOutdatedReclaimBytes(
					block.content,
					newKeys,
				);
			}
		}

		for (const toolUseId of this.committedOutdatedRewrites.keys()) {
			if (!seenToolUseIds.has(toolUseId)) {
				this.committedOutdatedRewrites.delete(toolUseId);
			}
		}

		if (pending.size === 0 || pendingBytes < this.minOutdatedRewriteBytes) {
			return;
		}

		for (const [toolUseId, keys] of pending) {
			let committed = this.committedOutdatedRewrites.get(toolUseId);
			if (!committed) {
				committed = new Set<string>();
				this.committedOutdatedRewrites.set(toolUseId, committed);
			}
			for (const key of keys) {
				committed.add(key);
			}
		}
	}

	/** Estimates reclaimable bytes for stale locators inside one tool-result block. */
	private estimateOutdatedReclaimBytes(
		content: ToolResultContent["content"],
		outdatedKeys: ReadonlySet<string>,
	): number {
		const allLocators = extractReadLocatorsFromToolResultContent(content);
		const blockFullyOutdated =
			allLocators.length > 0 &&
			allLocators.every((locator) =>
				outdatedKeys.has(toReadLocatorKey(locator)),
			);

		const attributeText = (text: string): number => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				return blockFullyOutdated || allLocators.length === 0
					? utf8ByteLength(this.truncateMiddle(text))
					: 0;
			}
			const entries = Array.isArray(parsed) ? parsed : [parsed];
			let total = 0;
			for (const entry of entries) {
				const locator = extractLocatorFromResultEntry(entry);
				if (locator && outdatedKeys.has(toReadLocatorKey(locator))) {
					total += this.providerBoundEntryBytes(entry);
				}
			}
			return total;
		};

		if (typeof content === "string") {
			return attributeText(content);
		}
		// Image siblings are rewritten positionally, so count them positionally too.
		const outdatedKeySet = new Set(outdatedKeys);
		let outdatedImageCount = 0;
		for (const entry of content) {
			if (entry.type === "text") {
				outdatedImageCount += countOutdatedImageEntries(
					entry.text,
					outdatedKeySet,
				);
			}
		}
		let total = 0;
		for (const entry of content) {
			if (entry.type === "text") {
				total += attributeText(entry.text);
			} else if (entry.type === "image") {
				if (outdatedImageCount > 0) {
					outdatedImageCount -= 1;
					total += utf8ByteLength(entry.data);
				}
			} else if (isStructuredToolResultEntry(entry)) {
				const locator = extractLocatorFromResultEntry(entry);
				if (locator && outdatedKeys.has(toReadLocatorKey(locator))) {
					total += this.providerBoundEntryBytes(entry);
				}
			} else if (entry.type === "file") {
				if (
					outdatedKeys.has(
						toReadLocatorKey({
							path: entry.path,
							startLine: null,
							endLine: null,
						}),
					)
				) {
					total += utf8ByteLength(this.truncateMiddle(entry.content));
				}
			}
		}
		return total;
	}

	private providerBoundEntryBytes(entry: unknown): number {
		const providerBound = this.truncateNestedStrings(entry);
		return utf8ByteLength(JSON.stringify(providerBound));
	}

	private resetIndexes(): void {
		this.indexedMessageCount = 0;
		this.indexedTailRef = undefined;
		this.toolNameByIdCache.clear();
		this.readLocatorsByToolUseIdCache.clear();
		this.latestReadToolUseByLocatorCache.clear();
		this.latestFullContentOwnerByPathCache.clear();
		this.readResultLocatorCache = new WeakMap<object, ReadLocator[]>();
	}

	private getReadLocators(block: ToolResultContent): ReadLocator[] {
		const blockRef = block as unknown as object;
		let parsed = this.readResultLocatorCache.get(blockRef);
		if (parsed === undefined) {
			parsed = extractReadLocatorsFromToolResultContent(block.content);
			this.readResultLocatorCache.set(blockRef, parsed);
		}
		if (parsed.length > 0) {
			return parsed;
		}
		return this.readLocatorsByToolUseIdCache.get(block.tool_use_id) ?? [];
	}

	private isOutdatedReadLocator(
		locator: ReadLocator,
		toolUseId: string,
	): boolean {
		const fullOwner = this.latestFullContentOwnerByPathCache.get(locator.path);
		if (fullOwner && fullOwner !== toolUseId) {
			return true;
		}
		return (
			this.latestReadToolUseByLocatorCache.get(toReadLocatorKey(locator)) !==
			toolUseId
		);
	}

	/**
	 * Tool results can outlive their paired tool_use block (compacted or
	 * imported histories), so fall back to the name carried on the result
	 * itself when the id lookup misses.
	 */
	private resolveToolName(block: ToolResultContent): string | undefined {
		const cached = this.toolNameByIdCache.get(block.tool_use_id);
		if (cached !== undefined) {
			return cached;
		}
		return typeof block.name === "string" && block.name.length > 0
			? block.name.toLowerCase()
			: undefined;
	}

	private truncateToolResultContent(
		content: ToolResultContent["content"],
	): ToolResultContent["content"] {
		if (typeof content === "string") {
			return this.truncateMiddle(content);
		}
		return content.map((entry) => {
			if (entry.type === "file") {
				const next = this.truncateMiddle(entry.content);
				return next === entry.content ? entry : { ...entry, content: next };
			}
			if (entry.type === "text") {
				const next = this.truncateMiddle(entry.text);
				return next === entry.text ? entry : { ...entry, text: next };
			}
			if (isStructuredToolResultEntry(entry)) {
				return this.truncateNestedStrings(entry) as typeof entry;
			}
			return entry;
		});
	}

	/**
	 * Deep-truncates string values inside structured tool outputs (e.g.
	 * `ToolOperationResult[]` from run_commands/read_files), which carry the
	 * payload in untyped `{query, result, ...}` fields rather than text
	 * blocks. Image blocks are left intact so base64 payloads survive.
	 */
	private truncateNestedStrings(value: unknown): unknown {
		if (typeof value === "string") {
			return this.truncateMiddle(value);
		}
		if (Array.isArray(value)) {
			let changed = false;
			const next = value.map((item) => {
				const out = this.truncateNestedStrings(item);
				if (out !== item) {
					changed = true;
				}
				return out;
			});
			return changed ? next : value;
		}
		if (value !== null && typeof value === "object") {
			if (isBinaryContentLike(value)) {
				return value;
			}
			let changed = false;
			const next: Record<string, unknown> = {};
			for (const [key, item] of Object.entries(value)) {
				const out = this.truncateNestedStrings(item);
				if (out !== item) {
					changed = true;
				}
				next[key] = out;
			}
			return changed ? next : value;
		}
		return value;
	}

	private truncateMiddle(text: string): string {
		return truncateMiddleByChars(
			text,
			this.maxToolResultChars,
			TRUNCATE_MARKER_DEFAULT,
		);
	}

	private truncateAssistantText(text: string): string {
		if (this.hasRepeatedToolCallMarkup(text)) {
			return truncateMiddleByChars(
				text,
				this.maxAssistantToolMarkupChars,
				TRUNCATE_ASSISTANT_TOOL_MARKUP_MARKER,
			);
		}
		return truncateMiddleByChars(
			text,
			this.maxAssistantTextChars,
			TRUNCATE_ASSISTANT_TEXT_MARKER,
		);
	}

	private hasRepeatedToolCallMarkup(text: string): boolean {
		if (text.length <= this.maxAssistantToolMarkupChars) {
			return false;
		}
		let count = 0;
		for (const _match of text.matchAll(TOOL_CALL_MARKUP_PATTERN)) {
			count += 1;
			if (count >= REPEATED_TOOL_CALL_MARKUP_THRESHOLD) {
				return true;
			}
		}
		return false;
	}

	private truncateToTotalTextBudget(messages: Message[]): Message[] {
		let totalBytes = countMessageTextBytes(messages);
		if (totalBytes <= this.maxTotalTextBytes) {
			return messages;
		}

		const next = messages.map((message) => {
			if (!Array.isArray(message.content)) {
				return { ...message };
			}
			return {
				...message,
				content: message.content.map((block) =>
					cloneContentBlockForMutation(block),
				),
			};
		});

		const candidates = collectTruncationCandidates(next);
		for (const candidate of candidates) {
			if (totalBytes <= this.maxTotalTextBytes) {
				break;
			}
			const currentBytes = candidate.byteLength;
			if (currentBytes <= candidate.minBytes) {
				continue;
			}
			const overflow = totalBytes - this.maxTotalTextBytes;
			const targetBytes = Math.max(candidate.minBytes, currentBytes - overflow);
			const truncated = truncateMiddleToBytes(
				candidate.get(),
				targetBytes,
				candidate.makeMarker,
			);
			candidate.set(truncated);
			totalBytes -= currentBytes - utf8ByteLength(truncated);
		}

		return next;
	}

	private resolveMediaBudget(): ResolvedMediaBudget {
		return resolveMediaBudget(this.mediaBudget);
	}
}

function parsePositiveIntegerEnv(
	value: string | undefined,
): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeLimitEnv(
	value: string | undefined,
): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "infinity" || normalized === "disable") {
		return Number.POSITIVE_INFINITY;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizePositiveLimit(
	value: number | undefined,
	fallback: number,
): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

function normalizeNonNegativeLimit(
	value: number | undefined,
	fallback: number,
): number {
	if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
		return fallback;
	}
	return Number.isFinite(value) ? Math.floor(value) : value;
}
