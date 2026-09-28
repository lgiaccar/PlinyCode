import type { ContentBlock, Message } from "@plinycode/shared";
import {
	isBinaryContentLike,
	isStructuredToolResultEntry,
} from "./content-entries";

const MIN_TOTAL_BUDGET_TOOL_RESULT_BYTES = 2_000;
const MIN_TOTAL_BUDGET_ASSISTANT_TEXT_BYTES = 40_000;
export const REPEATED_TOOL_CALL_MARKUP_THRESHOLD = 8;

export const TRUNCATE_MARKER_DEFAULT = (n: number) =>
	`\n\n...[truncated ${n} chars]...\n\n`;
const TRUNCATE_MARKER_BUDGET = (n: number) =>
	`\n\n...[truncated ${n} chars to fit provider request budget]...\n\n`;
export const TRUNCATE_ASSISTANT_TEXT_MARKER = (n: number) =>
	`\n\n...[assistant text truncated: omitted ${n} chars]...\n\n`;
const TRUNCATE_ASSISTANT_TEXT_BUDGET_MARKER = (n: number) =>
	`\n\n...[assistant text truncated: omitted ${n} chars to fit provider request budget]...\n\n`;
export const TRUNCATE_ASSISTANT_TOOL_MARKUP_MARKER = (n: number) =>
	`\n\n...[assistant text truncated: omitted ${n} chars due to repeated tool-call markup]...\n\n`;

interface TruncationCandidate {
	byteLength: number;
	minBytes: number;
	makeMarker: (removed: number) => string;
	get(): string;
	set(value: string): void;
}

export function countMessageTextBytes(messages: Message[]): number {
	let total = 0;
	for (const message of messages) {
		if (typeof message.content === "string") {
			total += utf8ByteLength(message.content);
			continue;
		}
		for (const block of message.content) {
			if (block.type === "text") {
				total += utf8ByteLength(block.text);
			} else if (block.type === "thinking") {
				total += utf8ByteLength(block.thinking);
			} else if (block.type === "file") {
				total += utf8ByteLength(block.content);
			} else if (block.type === "tool_use") {
				// Model-generated tool arguments ship on the wire too. Counting
				// them keeps the budget honest; if tool results alone cannot
				// absorb the overflow, oversized argument strings are truncated
				// as a last resort (see collectTruncationCandidates).
				total += countNestedStringBytes(block.input);
			} else if (block.type === "tool_result") {
				if (typeof block.content === "string") {
					total += utf8ByteLength(block.content);
				} else {
					for (const entry of block.content) {
						if (entry.type === "text") {
							total += utf8ByteLength(entry.text);
						} else if (entry.type === "file") {
							total += utf8ByteLength(entry.content);
						} else if (isStructuredToolResultEntry(entry)) {
							total += countNestedStringBytes(entry);
						}
					}
				}
			}
		}
	}
	return total;
}

export function collectTruncationCandidates(
	messages: Message[],
): TruncationCandidate[] {
	const resultCandidates: TruncationCandidate[] = [];
	const inputCandidates: TruncationCandidate[] = [];
	for (const message of messages) {
		if (message.role === "assistant" && typeof message.content === "string") {
			resultCandidates.push({
				byteLength: utf8ByteLength(message.content),
				minBytes: MIN_TOTAL_BUDGET_ASSISTANT_TEXT_BYTES,
				makeMarker: TRUNCATE_ASSISTANT_TEXT_BUDGET_MARKER,
				get: () => message.content as string,
				set: (value) => {
					message.content = value;
				},
			});
			continue;
		}
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "tool_use") {
				collectNestedStringCandidates(block.input, inputCandidates);
				continue;
			}
			if (message.role === "assistant" && block.type === "text") {
				resultCandidates.push({
					byteLength: utf8ByteLength(block.text),
					minBytes: MIN_TOTAL_BUDGET_ASSISTANT_TEXT_BYTES,
					makeMarker: TRUNCATE_ASSISTANT_TEXT_BUDGET_MARKER,
					get: () => block.text,
					set: (value) => {
						block.text = value;
					},
				});
				continue;
			}
			if (block.type !== "tool_result") {
				continue;
			}
			if (typeof block.content === "string") {
				resultCandidates.push({
					byteLength: utf8ByteLength(block.content),
					minBytes: MIN_TOTAL_BUDGET_TOOL_RESULT_BYTES,
					makeMarker: TRUNCATE_MARKER_BUDGET,
					get: () => block.content as string,
					set: (value) => {
						block.content = value;
					},
				});
				continue;
			}
			for (const entry of block.content) {
				if (entry.type === "text") {
					resultCandidates.push({
						byteLength: utf8ByteLength(entry.text),
						minBytes: MIN_TOTAL_BUDGET_TOOL_RESULT_BYTES,
						makeMarker: TRUNCATE_MARKER_BUDGET,
						get: () => entry.text,
						set: (value) => {
							entry.text = value;
						},
					});
				} else if (entry.type === "file") {
					resultCandidates.push({
						byteLength: utf8ByteLength(entry.content),
						minBytes: MIN_TOTAL_BUDGET_TOOL_RESULT_BYTES,
						makeMarker: TRUNCATE_MARKER_BUDGET,
						get: () => entry.content,
						set: (value) => {
							entry.content = value;
						},
					});
				} else if (isStructuredToolResultEntry(entry)) {
					collectNestedStringCandidates(entry, resultCandidates);
				}
			}
		}
	}
	// Tool results and assistant text truncate first; model-generated
	// tool_use arguments are a last resort because some providers
	// revalidate or replay them. All three being candidates keeps the
	// budget reclaimable no matter which side carries the overflow.
	resultCandidates.sort((l, r) => r.byteLength - l.byteLength);
	inputCandidates.sort((l, r) => r.byteLength - l.byteLength);
	return [...resultCandidates, ...inputCandidates];
}

const DSML_BAR = String.raw`[\|\uFF5C]`;
// Compiled once at module load; String.prototype.matchAll clones the regex
// per call, so sharing the global-flagged instance is safe.
export const TOOL_CALL_MARKUP_PATTERN = new RegExp(
	String.raw`<\s*(?:${DSML_BAR}\s*)?DSML\s*(?:${DSML_BAR}\s*)?(?:tool_calls|invoke)\b[^>]*>|<\s*/?\s*(?:tool_calls?|tool_call|function_calls?|function_call|invoke)\b[^>]*>`,
	"gi",
);

export function utf8ByteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

export function truncateMiddleByChars(
	text: string,
	maxChars: number,
	makeMarker: (removed: number) => string,
): string {
	if (text.length <= maxChars) {
		return text;
	}
	// Two-pass: marker length depends on the removed-char count, which depends
	// on the marker length. Compute a tentative marker, derive the final
	// removed count, then build the real marker.
	const tentativeMarker = makeMarker(text.length - maxChars);
	const tentativeKeep = Math.max(
		0,
		Math.floor((maxChars - tentativeMarker.length) / 2),
	);
	const removed = Math.max(0, text.length - tentativeKeep * 2);
	const marker = makeMarker(removed);
	const keep = Math.max(0, Math.floor((maxChars - marker.length) / 2));
	const start = text.slice(0, keep);
	const end = keep > 0 ? text.slice(-keep) : "";
	return `${start}${marker}${end}`;
}

export function truncateMiddleToBytes(
	text: string,
	maxBytes: number,
	makeMarker: (removed: number) => string,
): string {
	if (utf8ByteLength(text) <= maxBytes) {
		return text;
	}
	// Binary search the largest char-length whose UTF-8 byte length fits.
	let low = 0;
	let high = text.length;
	let best = truncateMiddleByChars(text, 0, makeMarker);
	while (low <= high) {
		const mid = (low + high) >>> 1;
		const candidate = truncateMiddleByChars(text, mid, makeMarker);
		if (utf8ByteLength(candidate) <= maxBytes) {
			best = candidate;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return best;
}

export function cloneContentBlockForMutation(
	block: ContentBlock,
): ContentBlock {
	if (block.type === "tool_use") {
		// Inputs are budget-truncation candidates of last resort, so they need
		// the same deep-clone treatment as structured results: a shallow copy
		// would leak truncation mutations back into conversation history.
		return {
			...block,
			input: deepCloneJsonLike(block.input) as typeof block.input,
		};
	}
	if (block.type !== "tool_result" || typeof block.content === "string") {
		return { ...block };
	}
	return {
		...block,
		// Structured entries can nest the payload strings arbitrarily deep, so
		// a shallow copy would leak budget-truncation mutations back into the
		// original conversation history.
		content: block.content.map((entry) =>
			isStructuredToolResultEntry(entry)
				? (deepCloneJsonLike(entry) as typeof entry)
				: { ...entry },
		),
	};
}

function countNestedStringBytes(value: unknown): number {
	if (typeof value === "string") {
		return utf8ByteLength(value);
	}
	if (Array.isArray(value)) {
		let total = 0;
		for (const item of value) {
			total += countNestedStringBytes(item);
		}
		return total;
	}
	if (value !== null && typeof value === "object") {
		if (isBinaryContentLike(value)) {
			return 0;
		}
		let total = 0;
		for (const item of Object.values(value)) {
			total += countNestedStringBytes(item);
		}
		return total;
	}
	return 0;
}

function collectNestedStringCandidates(
	container: unknown,
	candidates: TruncationCandidate[],
): void {
	if (Array.isArray(container)) {
		container.forEach((item, index) => {
			if (typeof item === "string") {
				candidates.push({
					byteLength: utf8ByteLength(item),
					minBytes: MIN_TOTAL_BUDGET_TOOL_RESULT_BYTES,
					makeMarker: TRUNCATE_MARKER_BUDGET,
					get: () => container[index] as string,
					set: (value) => {
						container[index] = value;
					},
				});
			} else {
				collectNestedStringCandidates(item, candidates);
			}
		});
		return;
	}
	if (container !== null && typeof container === "object") {
		if (isBinaryContentLike(container)) {
			return;
		}
		const record = container as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			const item = record[key];
			if (typeof item === "string") {
				candidates.push({
					byteLength: utf8ByteLength(item),
					minBytes: MIN_TOTAL_BUDGET_TOOL_RESULT_BYTES,
					makeMarker: TRUNCATE_MARKER_BUDGET,
					get: () => record[key] as string,
					set: (value) => {
						record[key] = value;
					},
				});
			} else {
				collectNestedStringCandidates(item, candidates);
			}
		}
	}
}

function deepCloneJsonLike(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(deepCloneJsonLike);
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			out[key] = deepCloneJsonLike(item);
		}
		return out;
	}
	return value;
}
