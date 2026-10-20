/**
 * Prunes stale context from a request before it goes out. The stored
 * transcript is never changed: like `dropPriorTurnReasoning`, this works on
 * the copy that becomes the provider request, and on the copy compaction
 * sizes, so compaction triggers later.
 *
 * What it removes, measured on real long sessions:
 *
 * - Tool results from earlier user turns. A `search_codebase` result of
 *   200k characters or a 150k `read_files` result stays in the history for
 *   the rest of the conversation, re-sent on every call. Past its turn it is
 *   replaced by a stub naming the tool, what was asked and the size.
 * - Aged tool results of the current turn, middle-cut to a head and a tail.
 * - The deliberation that preceded a tool call. Models that reason in their
 *   content (Kimi K2.6 on the Pliny gateway has no reasoning channel) write
 *   "Wait… Actually… Let me…" for tens of thousands of characters before each
 *   call, as ordinary text. In earlier turns only the tail, which states the
 *   step taken, is kept. Final answers (no tool call) are kept whole.
 * - The input of a failed, oversized tool call: an `editor` call rejected
 *   for a 25k-character `new_text` left all of it in the history.
 *
 * Prompt-cache friendliness: the earlier-turn rules depend only on where the
 * current turn starts, so a message changes exactly once, on the first call
 * of the next turn, when the request has a new user message at its end
 * anyway. The in-turn rules would move one message per call on a rolling
 * window, invalidating a provider's cached prefix on every call; instead the
 * aged boundary advances in blocks of `iterationBlockSize` iterations, so the
 * prefix is rewritten once per block. Both are deterministic for a given
 * history, and a block that was cut stays cut.
 *
 * A model without a prompt cache (the free pool on the Pliny gateway reads
 * none: cacheReadTokens was 0 on a thousand calls) has no prefix to protect,
 * and the block scheme only delayed the pruning: a 72k-character monologue
 * stayed in the request for sixteen calls and brought on the next
 * compaction. For such a model (`mode: "uncached"`) the in-turn rules apply
 * once a call is `uncachedKeepRecentIterations` old, and the deliberation
 * before a tool call keeps a head as well as a tail.
 *
 * Known limit: a text-only message in an earlier turn (a stall the guard
 * later nudged, or a long final answer) is kept whole.
 */

import type {
	AgentMessage,
	AgentMessagePart,
	AgentToolResultPart,
	StaleContextPruningOptions,
} from "@plinycode/shared";
import { isImageContentLike } from "./content-entries";
import { findCurrentTurnStart } from "./prior-turn-reasoning";
import { truncateMiddleByChars } from "./truncation";

export type StaleContextOptions = StaleContextPruningOptions;

export const DEFAULT_STALE_CONTEXT_OPTIONS: StaleContextOptions = {
	priorTurnToolResultChars: 2_000,
	keepRecentIterations: 8,
	iterationBlockSize: 8,
	currentTurnToolResultChars: 8_000,
	middleCutHeadChars: 1_500,
	middleCutTailChars: 1_500,
	priorTurnDeliberationTailChars: 600,
	currentTurnAssistantTextChars: 6_000,
	failedToolInputChars: 6_000,
	failedToolInputStringChars: 1_000,
	uncachedKeepRecentIterations: 2,
	currentTurnDeliberationHeadChars: 1_500,
	currentTurnDeliberationTailChars: 600,
};

const NUMERIC_OPTION_KEYS = [
	"priorTurnToolResultChars",
	"keepRecentIterations",
	"iterationBlockSize",
	"currentTurnToolResultChars",
	"middleCutHeadChars",
	"middleCutTailChars",
	"priorTurnDeliberationTailChars",
	"currentTurnAssistantTextChars",
	"failedToolInputChars",
	"failedToolInputStringChars",
	"uncachedKeepRecentIterations",
	"currentTurnDeliberationHeadChars",
	"currentTurnDeliberationTailChars",
] as const;

export interface StaleContextEnvironment {
	/** Whether the model the session sends to reads a prompt cache. */
	promptCache?: boolean;
}

/**
 * Defaults with the numeric overrides applied, and the mode resolved: the
 * block scheme for a cached model, immediate aging for one without a prompt
 * cache. `promptCacheAware` decides; `"auto"` follows the environment, and an
 * unknown environment counts as cached (the conservative choice). An
 * already-resolved `mode` in the overrides is kept.
 */
export function resolveStaleContextOptions(
	overrides?: Partial<StaleContextOptions>,
	environment?: StaleContextEnvironment,
): StaleContextOptions {
	const options: StaleContextOptions = { ...DEFAULT_STALE_CONTEXT_OPTIONS };
	for (const key of NUMERIC_OPTION_KEYS) {
		const value = overrides?.[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
			options[key] = value;
		}
	}
	const aware = overrides?.promptCacheAware ?? "auto";
	const mode: "cached" | "uncached" =
		overrides?.mode === "cached" || overrides?.mode === "uncached"
			? overrides.mode
			: aware === "auto"
				? environment?.promptCache === false
					? "uncached"
					: "cached"
				: aware
					? "cached"
					: "uncached";
	options.mode = mode;
	if (mode === "uncached") {
		options.keepRecentIterations = Math.min(
			options.keepRecentIterations,
			options.uncachedKeepRecentIterations,
		);
		options.iterationBlockSize = 1;
	}
	return options;
}

// =============================================================================
// Output helpers
// =============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The fields of a structured entry that carry its payload (not `query`, `path` or `type`). */
const CONTENT_KEYS = ["result", "text", "content", "output", "error"] as const;

/** Chars of the payload strings in `output`, images left out. */
export function measureToolOutputChars(output: unknown): number {
	if (typeof output === "string") {
		return output.length;
	}
	if (Array.isArray(output)) {
		return output.reduce<number>(
			(total, entry) => total + measureToolOutputChars(entry),
			0,
		);
	}
	if (isRecord(output)) {
		if (isImageContentLike(output)) {
			return 0;
		}
		let total = 0;
		for (const key of CONTENT_KEYS) {
			const value = output[key];
			if (typeof value === "string") {
				total += value.length;
			} else if (Array.isArray(value) || isRecord(value)) {
				total += measureToolOutputChars(value);
			}
		}
		return total;
	}
	return 0;
}

/** Whether the output carries an image, at the top level or inside an entry's result. */
export function hasImageOutput(output: unknown): boolean {
	if (Array.isArray(output)) {
		return output.some((entry) => hasImageOutput(entry));
	}
	if (isRecord(output)) {
		if (isImageContentLike(output)) {
			return true;
		}
		return Object.values(output).some(
			(value) => Array.isArray(value) && hasImageOutput(value),
		);
	}
	return false;
}

function firstLine(text: string, maxChars = 120): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}

/** What the call asked for: the first line of a string output, or the first entry's query or path. */
export function toolOutputHeadline(output: unknown): string | undefined {
	if (typeof output === "string") {
		return firstLine(output) || undefined;
	}
	if (Array.isArray(output)) {
		const [entry] = output;
		if (isRecord(entry)) {
			if (typeof entry.query === "string") {
				return firstLine(entry.query) || undefined;
			}
			if (typeof entry.path === "string") {
				return firstLine(entry.path) || undefined;
			}
			if (typeof entry.text === "string") {
				return firstLine(entry.text) || undefined;
			}
		}
	}
	return undefined;
}

function elidedStub(
	toolName: string,
	chars: number,
	headline: string | undefined,
): string {
	return (
		`[${toolName} output elided (${chars} chars) — earlier turn` +
		(headline ? `; it was: "${headline}"` : "") +
		"; call the tool again if you need it]"
	);
}

/**
 * The stub that replaces an earlier turn's tool output. A string output
 * becomes one line; a structured entry keeps `query`, `success` and `error`
 * and loses its `result`; text and file entries lose their text.
 */
export function elideToolResultOutput(
	output: unknown,
	toolName: string,
): unknown {
	if (typeof output === "string") {
		return elidedStub(toolName, output.length, firstLine(output) || undefined);
	}
	if (!Array.isArray(output)) {
		return output;
	}
	return output.map((entry) => {
		if (!isRecord(entry) || isImageContentLike(entry)) {
			return entry;
		}
		const chars = measureToolOutputChars(entry);
		if ("result" in entry) {
			return {
				...entry,
				result: `[output elided (${chars} chars) — earlier turn; call the tool again if you need it]`,
			};
		}
		if (entry.type === "text" && typeof entry.text === "string") {
			return {
				...entry,
				text: elidedStub(toolName, chars, firstLine(entry.text) || undefined),
			};
		}
		if (entry.type === "file" && typeof entry.content === "string") {
			return {
				...entry,
				content: `[file content elided (${chars} chars) — earlier turn; read it again if you need it]`,
			};
		}
		return entry;
	});
}

function middleCut(
	text: string,
	toolName: string,
	options: Pick<
		StaleContextOptions,
		"currentTurnToolResultChars" | "middleCutHeadChars" | "middleCutTailChars"
	>,
): string {
	if (text.length <= options.currentTurnToolResultChars) {
		return text;
	}
	const marker = (removed: number) =>
		`\n\n...[${toolName} output middle cut: omitted ${removed} chars — an older step of this turn; call the tool again if you need it]...\n\n`;
	const maxChars =
		options.middleCutHeadChars +
		options.middleCutTailChars +
		marker(text.length).length;
	return truncateMiddleByChars(text, maxChars, marker);
}

/** Every string of an aged in-turn output above the limit is cut to a head and a tail. */
export function middleCutToolResultOutput(
	output: unknown,
	toolName: string,
	options: Pick<
		StaleContextOptions,
		"currentTurnToolResultChars" | "middleCutHeadChars" | "middleCutTailChars"
	>,
): unknown {
	if (typeof output === "string") {
		return middleCut(output, toolName, options);
	}
	if (!Array.isArray(output)) {
		return output;
	}
	let changed = false;
	const next = output.map((entry) => {
		if (!isRecord(entry) || isImageContentLike(entry)) {
			return entry;
		}
		for (const key of ["result", "text", "content"] as const) {
			const value = entry[key];
			if (typeof value === "string") {
				const cut = middleCut(value, toolName, options);
				if (cut !== value) {
					changed = true;
					return { ...entry, [key]: cut };
				}
			}
		}
		return entry;
	});
	return changed ? next : output;
}

/** The last `tailChars` of a deliberation, moved forward to a line break when one is near. */
/**
 * Head and tail of a long deliberation, for a model without a prompt cache:
 * the head says what the model set out to do, the tail which step it took.
 */
export function cutAssistantTextMiddle(
	text: string,
	headChars: number,
	tailChars: number,
): string {
	if (text.length <= headChars + tailChars) {
		return text;
	}
	let headEnd = headChars;
	const headBreak = text.lastIndexOf("\n", headEnd);
	if (headBreak !== -1 && headEnd - headBreak <= 200) {
		headEnd = headBreak;
	}
	let tailStart = text.length - tailChars;
	const tailBreak = text.indexOf("\n", tailStart);
	if (tailBreak !== -1 && tailBreak - tailStart <= 200) {
		tailStart = tailBreak + 1;
	}
	const omitted = tailStart - headEnd;
	return `${text.slice(0, headEnd)}\n[deliberation middle cut: omitted ${omitted} chars]\n${text.slice(tailStart)}`;
}

export function cutAssistantTextTail(text: string, tailChars: number): string {
	if (text.length <= tailChars) {
		return text;
	}
	let start = text.length - tailChars;
	const lineBreak = text.indexOf("\n", start);
	if (lineBreak !== -1 && lineBreak - start <= 200) {
		start = lineBreak + 1;
	}
	const omitted = start;
	return `[earlier deliberation cut: omitted ${omitted} chars]\n${text.slice(start)}`;
}

/** A deep copy of `input` whose long strings are replaced; keys and structure are kept. */
export function elideLargeInputStrings(
	input: unknown,
	maxStringChars: number,
): unknown {
	if (typeof input === "string") {
		return input.length > maxStringChars
			? `<elided ${input.length} chars>`
			: input;
	}
	if (Array.isArray(input)) {
		return input.map((item) => elideLargeInputStrings(item, maxStringChars));
	}
	if (isRecord(input)) {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(input)) {
			out[key] = elideLargeInputStrings(value, maxStringChars);
		}
		return out;
	}
	return input;
}

// =============================================================================
// The pass
// =============================================================================

function safeJsonLength(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

/**
 * Pure. Never mutates `messages`; a message nothing applies to is returned by
 * identity, so callers comparing by reference see no change.
 */
export function pruneStaleContext(
	messages: readonly AgentMessage[],
	overrides: Partial<StaleContextOptions> = {},
): AgentMessage[] {
	const options = resolveStaleContextOptions(overrides);
	const found = findCurrentTurnStart(messages);
	const turnStart = found < 0 ? 0 : found;

	// Results by call id, for the failed-input rule; iteration numbers for the
	// current turn (assistant messages counted from 1, a tool message takes its
	// assistant's number, everything before the turn is 0).
	const resultByCallId = new Map<string, AgentToolResultPart>();
	const iterationOf: number[] = new Array(messages.length).fill(0);
	let iteration = 0;
	for (const [index, message] of messages.entries()) {
		for (const part of message.content) {
			if (part.type === "tool-result") {
				resultByCallId.set(part.toolCallId, part);
			}
		}
		if (index < turnStart) {
			continue;
		}
		if (message.role === "assistant") {
			iteration += 1;
		}
		iterationOf[index] = iteration;
	}
	const inTurnIterations = iteration;
	const beyondKeep = inTurnIterations - options.keepRecentIterations;
	const block = Math.max(1, options.iterationBlockSize);
	const agedUpTo = beyondKeep <= 0 ? 0 : Math.floor(beyondKeep / block) * block;

	const callFailed = (toolCallId: string) =>
		resultByCallId.get(toolCallId)?.isError === true;

	return messages.map((message, index) => {
		const earlierTurn = index < turnStart;
		const aged =
			!earlierTurn && iterationOf[index] >= 1 && iterationOf[index] <= agedUpTo;
		if (!earlierTurn && !aged) {
			return message;
		}
		const hasToolCall = message.content.some(
			(part) => part.type === "tool-call",
		);
		let changed = false;
		const content: AgentMessagePart[] = message.content.map((part) => {
			if (part.type === "tool-result") {
				if (part.isError === true || hasImageOutput(part.output)) {
					return part;
				}
				const chars = measureToolOutputChars(part.output);
				if (earlierTurn) {
					if (chars <= options.priorTurnToolResultChars) {
						return part;
					}
					changed = true;
					return {
						...part,
						output: elideToolResultOutput(part.output, part.toolName),
					};
				}
				if (chars <= options.currentTurnToolResultChars) {
					return part;
				}
				const output = middleCutToolResultOutput(
					part.output,
					part.toolName,
					options,
				);
				if (output === part.output) {
					return part;
				}
				changed = true;
				return { ...part, output };
			}
			if (part.type === "text" && message.role === "assistant") {
				const limit = earlierTurn
					? hasToolCall
						? options.priorTurnDeliberationTailChars
						: Number.POSITIVE_INFINITY
					: options.currentTurnAssistantTextChars;
				if (part.text.length <= limit) {
					return part;
				}
				changed = true;
				if (!earlierTurn && options.mode === "uncached" && hasToolCall) {
					return {
						...part,
						text: cutAssistantTextMiddle(
							part.text,
							options.currentTurnDeliberationHeadChars,
							options.currentTurnDeliberationTailChars,
						),
					};
				}
				return {
					...part,
					text: cutAssistantTextTail(
						part.text,
						options.priorTurnDeliberationTailChars,
					),
				};
			}
			if (part.type === "tool-call") {
				if (
					!callFailed(part.toolCallId) ||
					safeJsonLength(part.input) <= options.failedToolInputChars
				) {
					return part;
				}
				changed = true;
				return {
					...part,
					input: elideLargeInputStrings(
						part.input,
						options.failedToolInputStringChars,
					),
				};
			}
			return part;
		});
		return changed ? { ...message, content } : message;
	});
}
