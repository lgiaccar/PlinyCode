/**
 * Tool-call ids that every OpenAI-compatible backend accepts.
 *
 * A conversation can mix models: FreeAuto/BalanceAuto route one turn to GPT,
 * Kimi or Gemini and the next to Claude. History then carries ids such as
 * `call_abc`, `functions.read_file:0` or our own `tool_<nanoid>` fallbacks.
 * Gateways that forward Chat Completions to Anthropic on AWS Bedrock reject
 * any `tool_use.id` outside `^[a-zA-Z0-9-]+$` ("messages.N.content.M.tool_use.id:
 * String should match pattern"), and that failure benches every Claude model
 * for the rest of the run.
 *
 * The mapping is a pure function of the original id, so an assistant
 * `tool_calls[].id` and the matching `role:"tool"` `tool_call_id` always map
 * to the same value, in this request and every later one. Stored history
 * keeps the original ids; only the wire body is rewritten.
 *
 * Kimi is the exception. Its chat template shows the model its earlier calls
 * by id, and the id is where it reads the tool's name: `functions.read_files:3`.
 * Rewritten to `functions-read-files-3-9tb01v`, the history teaches the model
 * a format its own server cannot parse, and its next calls come back mangled
 * or not at all. A request to a Kimi model keeps its ids, which
 * `withKimiToolCallIds` has already put in that form.
 */

const SAFE_TOOL_CALL_ID = /^[a-zA-Z0-9-]+$/;
const MAX_TOOL_CALL_ID_LENGTH = 64;

/** 32-bit FNV-1a, base36: a short, stable suffix that keeps rewritten ids distinct. */
function fnv1a(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

export function toSafeToolCallId(id: string): string {
	if (SAFE_TOOL_CALL_ID.test(id) && id.length <= MAX_TOOL_CALL_ID_LENGTH) {
		return id;
	}
	const cleaned = id
		.replace(/[^a-zA-Z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return `${cleaned || "call"}-${fnv1a(id)}`;
}

/** True for a request to a Kimi model, whatever prefix the gateway gives its id. */
function readsToolNamesFromCallIds(body: Record<string, unknown>): boolean {
	return typeof body.model === "string" && /kimi/i.test(body.model);
}

type WireToolCall = { id?: unknown } & Record<string, unknown>;
type WireMessage = {
	tool_calls?: unknown;
	tool_call_id?: unknown;
} & Record<string, unknown>;

/**
 * Rewrites `messages[].tool_calls[].id` and `messages[].tool_call_id` in a
 * serialized Chat Completions body to {@link toSafeToolCallId}. Returns the
 * body unchanged when no id needs rewriting.
 */
export function withSafeToolCallIds(
	body: Record<string, unknown>,
): Record<string, unknown> {
	if (!Array.isArray(body.messages) || readsToolNamesFromCallIds(body)) {
		return body;
	}
	let changed = false;
	const safe = (id: unknown): unknown => {
		if (typeof id !== "string") {
			return id;
		}
		const next = toSafeToolCallId(id);
		if (next !== id) {
			changed = true;
		}
		return next;
	};
	const messages = (body.messages as WireMessage[]).map((message) => {
		if (!message || typeof message !== "object") {
			return message;
		}
		let next = message;
		if (Array.isArray(message.tool_calls)) {
			next = {
				...next,
				tool_calls: (message.tool_calls as WireToolCall[]).map((call) =>
					call && typeof call === "object" && "id" in call
						? { ...call, id: safe(call.id) }
						: call,
				),
			};
		}
		if ("tool_call_id" in message) {
			next = { ...next, tool_call_id: safe(message.tool_call_id) };
		}
		return next;
	});
	return changed ? { ...body, messages } : body;
}
