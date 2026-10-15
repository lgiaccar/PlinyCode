/**
 * Conservative chars-per-token approximation used for compaction triggering
 * and request-size diagnostics. Uses 3 chars/token (slightly over-counts vs
 * the conventional 4) so trigger thresholds fire before provider rejection
 * rather than after.
 */

export const CHARS_PER_TOKEN = 3;

/**
 * What one image (or other binary payload) is counted as. Providers charge an
 * image by its pixel area, about 1,600 tokens at the largest size most of
 * them accept; counting its base64 text at three characters per token put a
 * 1 MB screenshot at some 350k tokens, which triggered compaction for nothing
 * and dropped the output-token clamp.
 */
export const IMAGE_TOKEN_ESTIMATE = 1_600;
const IMAGE_PLACEHOLDER = "#".repeat(IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN);
/** Shorter strings are counted as text, whatever they look like. */
const BINARY_PAYLOAD_MIN_CHARS = 2_048;
const BASE64_PREFIX = /^[A-Za-z0-9+/=\r\n]+$/;
const BASE64_CLASSES = [/[A-Z]/, /[a-z]/, /[0-9]/, /[+/]/];

/**
 * A base64 blob or a data URL: image or file bytes, never prose or code. Only
 * the start is inspected: anything a tokenizer would count as text contains
 * spaces or punctuation that base64 does not, and encoded bytes mix upper
 * case, lower case, digits and `+/` within a few hundred characters, where a
 * repeated character, a hex digest or a long identifier does not.
 */
export function isBinaryPayload(value: string): boolean {
	if (value.length < BINARY_PAYLOAD_MIN_CHARS) {
		return false;
	}
	if (value.startsWith("data:")) {
		return true;
	}
	const sample = value.slice(0, 512);
	if (!BASE64_PREFIX.test(sample)) {
		return false;
	}
	return BASE64_CLASSES.filter((pattern) => pattern.test(sample)).length >= 3;
}

/**
 * JSON of `value` for token counting: binary payloads are replaced by a
 * placeholder worth IMAGE_TOKEN_ESTIMATE tokens. Falls back to String() when
 * the value cannot be serialized.
 */
export function serializeForTokenEstimate(value: unknown): string {
	try {
		return (
			JSON.stringify(value, (_key, nested: unknown) =>
				typeof nested === "string" && isBinaryPayload(nested)
					? IMAGE_PLACEHOLDER
					: nested,
			) ?? ""
		);
	} catch {
		return safeStringify(value);
	}
}

/** Estimated tokens of any value, images counted at IMAGE_TOKEN_ESTIMATE each. */
export function estimateValueTokens(value: unknown): number {
	return estimateTokens(serializeForTokenEstimate(value).length);
}

export function estimateTokens(chars: number): number {
	return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

export interface TokenEstimatedRequest {
	systemPrompt?: string;
	messages: readonly unknown[];
	tools?: readonly unknown[];
}

function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		return (
			JSON.stringify(value, (_key, nestedValue: unknown) => {
				if (typeof nestedValue === "bigint") {
					return nestedValue.toString();
				}
				if (typeof nestedValue !== "object" || nestedValue === null) {
					return nestedValue;
				}
				if (seen.has(nestedValue)) {
					return "[Circular]";
				}
				seen.add(nestedValue);
				return nestedValue;
			}) ?? ""
		);
	} catch {
		return String(value ?? "");
	}
}

/**
 * Estimate the complete provider request payload so request execution and
 * pre-request policies use the same definition of input utilization.
 */
export function estimateRequestInputTokens(
	request: TokenEstimatedRequest,
): number {
	const serialized = serializeForTokenEstimate({
		systemPrompt: request.systemPrompt,
		messages: request.messages,
		tools: request.tools,
	});
	// Deliberately over-estimate slightly to leave room for provider formatting,
	// tool schema overhead, and tokenizer drift.
	return estimateTokens(serialized.length);
}
