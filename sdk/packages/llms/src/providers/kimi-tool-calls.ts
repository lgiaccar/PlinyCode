/**
 * Kimi's tool calls, where the serving side's own parser gives up on them.
 *
 * Kimi K2-lineage models write a tool call in their own token format:
 *
 *   <|tool_calls_section_begin|><|tool_call_begin|>functions.read_files:3
 *   <|tool_call_argument_begin|>{"files": […]}<|tool_call_end|><|tool_calls_section_end|>
 *
 * `functions.read_files:3` is the call's id: the tool's name and a running
 * index. The model's chat template shows it its earlier calls by that id, not
 * by name. Two things follow, and this module handles both.
 *
 * - **The ids we send back matter.** A history carries ids in other shapes:
 *   from other models the router used (`call_abc`, `toolu_01…`), assigned by
 *   the server when it could not parse a call (`chatcmpl-tool-916f…`), or
 *   malformed by the model itself (`functions-run-commands:1`). Replayed,
 *   those ids are what the model imitates on its next call — it opens a call
 *   with `chatcmpl-tool-…` and has no tool name to go with it — so one bad id
 *   breeds more. `withKimiToolCallIds` rewrites every id in the outgoing
 *   history to the canonical form, and `withSafeToolCallIds`
 *   (`routing/tool-call-ids.ts`) leaves a Kimi request's ids alone instead of
 *   rewriting them for Bedrock.
 * - **A call the server could not parse still reaches us**, either glued into
 *   the tool name (` functions-read_files-2-4wzk2r {"files": […]}
 *   <|tool_call_end|>`, with empty arguments) or left in the reply text.
 *   `parseGluedToolCall` and `createLeakedToolCallFilter` read the tool and
 *   its arguments back out, so the call runs instead of failing as "no tool
 *   is named …" or ending the turn.
 */

import type { AgentMessage } from "@plinycode/shared";
import { parseJsonStream } from "@plinycode/shared";

/**
 * Namespaces some models glue onto a tool name. Kimi K2.6's chat template
 * leaks its `functions` namespace into the name it emits
 * (`functions-read_files`, `functions.read_files`), and the gateway passes
 * that through as the tool name; other open models hyphenate
 * (`run-commands`). The AI SDK then rejects the call as an unavailable tool,
 * and a weak model rarely recovers from that error: it apologises in text,
 * announces the corrected call, and never makes it.
 */
const TOOL_NAME_NAMESPACE =
	/^(?:functions|function|tools|tool|default_api|namespace|multi_tool_use)[.:/_-]+/i;

/** What follows the tool name in a call id: `:3`, or `-2-4wzk2r` when the model mangles it. */
const CALL_INDEX_SUFFIX = /^\d+(?:_[a-z0-9]+)*$/;

/** Kimi's control tokens, e.g. `<|tool_call_end|>`. */
const CONTROL_TOKEN = /<\|[a-z0-9_]+\|>/gi;

const normalizeToolName = (name: string) =>
	name.toLowerCase().replace(/[-.:]/g, "_");

/**
 * The available tool a misnamed call most plausibly meant: the name with its
 * namespace stripped, compared case-insensitively and with hyphens read as
 * underscores, or written in camelCase (`readFiles`). A call id used as the
 * name (`functions.read_files:3`,
 * `functions-read-files-5-w53hn3x`) resolves to its tool as well. Undefined
 * when nothing matches, or when the name was fine.
 */
export function resolveMisnamedTool(
	toolName: string,
	availableTools: readonly string[],
): string | undefined {
	const requested = toolName.trim();
	if (!requested || availableTools.includes(requested)) {
		return undefined;
	}
	const byNormalized = new Map(
		availableTools.map((name) => [normalizeToolName(name), name] as const),
	);
	const withoutNamespace = requested.replace(TOOL_NAME_NAMESPACE, "");
	for (const candidate of [requested, withoutNamespace]) {
		if (availableTools.includes(candidate)) {
			return candidate;
		}
		const match = byNormalized.get(normalizeToolName(candidate));
		if (match) {
			return match;
		}
	}
	// camelCase for snake_case (`readFiles`): compare without separators, and
	// only when exactly one tool reads that way.
	const squash = (name: string) => normalizeToolName(name).replace(/_/g, "");
	const squashed = squash(withoutNamespace);
	const sameLetters = availableTools.filter(
		(name) => squash(name) === squashed,
	);
	if (sameLetters.length === 1) {
		return sameLetters[0];
	}
	// A call id: the tool's name followed by the call's index. The longest
	// tool name wins, so `read_files_2` prefers `read_files` over `read`.
	const normalized = normalizeToolName(withoutNamespace);
	let best: { normalized: string; name: string } | undefined;
	for (const [candidate, name] of byNormalized) {
		if (
			normalized.startsWith(`${candidate}_`) &&
			CALL_INDEX_SUFFIX.test(normalized.slice(candidate.length + 1)) &&
			(!best || candidate.length > best.normalized.length)
		) {
			best = { normalized: candidate, name };
		}
	}
	return best?.name;
}

/** The JSON object embedded in a string, serialised; undefined when there is none. */
function embeddedJsonObject(text: string): string | undefined {
	const start = text.indexOf("{");
	if (start < 0) {
		return undefined;
	}
	const end = text.lastIndexOf("}");
	const candidate =
		end > start ? text.slice(start, end + 1) : text.slice(start);
	const parsed = parseJsonStream(candidate);
	return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
		? JSON.stringify(parsed)
		: undefined;
}

/**
 * Reads a whole tool call out of one string: the call id or tool name, then
 * its JSON arguments, with Kimi's control tokens anywhere around them.
 * Undefined unless the leading name resolves to an available tool.
 */
export function parseGluedToolCall(
	raw: string,
	availableTools: readonly string[],
): { toolName: string; input?: string } | undefined {
	const text = raw.replace(CONTROL_TOKEN, " ").trim();
	const head = text.match(/^[^\s{]+/)?.[0];
	if (!head) {
		return undefined;
	}
	const toolName = availableTools.includes(head)
		? head
		: resolveMisnamedTool(head, availableTools);
	if (!toolName) {
		return undefined;
	}
	const input = embeddedJsonObject(text.slice(head.length));
	return { toolName, ...(input ? { input } : {}) };
}

/** A tool name short and clean enough to quote back to the model. */
export function displayToolName(toolName: string, maxChars = 80): string {
	const clean = toolName
		.replace(CONTROL_TOKEN, " ")
		.replace(/\s+/g, " ")
		.trim();
	return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
}

/** The id Kimi itself gives a call: the tool's name and the call's index in the conversation. */
function kimiToolCallId(toolName: string, index: number): string {
	return `functions.${toolName}:${index}`;
}

/** The tool a stored call names, cleaned up enough to stand in a call id. */
function toolNameForId(
	toolName: string,
	availableTools: readonly string[],
): string {
	const resolved = parseGluedToolCall(toolName, availableTools)?.toolName;
	if (resolved) {
		return resolved;
	}
	const head =
		toolName
			.replace(CONTROL_TOKEN, " ")
			.trim()
			.match(/^[^\s{]+/)?.[0] ?? "";
	return (
		head.replace(TOOL_NAME_NAMESPACE, "").replace(/[^A-Za-z0-9_-]/g, "_") ||
		"tool"
	);
}

/**
 * The history with every tool-call id rewritten to Kimi's own form,
 * `functions.<tool>:<index>`, counting calls from 0 in conversation order.
 * Tool results follow their call's new id. Ids are a private matter between
 * each request and its reply, so rewriting them changes nothing for the
 * runtime, which keeps the ids it stored.
 */
export function withKimiToolCallIds(
	messages: readonly AgentMessage[],
	availableTools: readonly string[],
): AgentMessage[] {
	const renamed = new Map<string, string>();
	let index = 0;
	return messages.map((message) => {
		let changed = false;
		const content = message.content.map((part) => {
			if (part.type === "tool-call") {
				const id = kimiToolCallId(
					toolNameForId(part.toolName, availableTools),
					index,
				);
				index += 1;
				renamed.set(part.toolCallId, id);
				if (id === part.toolCallId) {
					return part;
				}
				changed = true;
				return { ...part, toolCallId: id };
			}
			if (part.type === "tool-result") {
				const id = renamed.get(part.toolCallId);
				if (!id || id === part.toolCallId) {
					return part;
				}
				changed = true;
				return { ...part, toolCallId: id };
			}
			return part;
		});
		return changed ? { ...message, content } : message;
	});
}

/** Both `<|tool_calls_section_begin|>` and `<|tool_call_begin|>` start like this. */
const LEAK_MARKER = "<|tool_call";
const CALL_BEGIN = "<|tool_call_begin|>";
const CALL_END = "<|tool_call_end|>";

export interface RecoveredToolCall {
	toolName: string;
	input: Record<string, unknown>;
}

/** The tool calls in a leaked tool-call section; only those that name an available tool and carry JSON arguments. */
export function parseLeakedToolCalls(
	section: string,
	availableTools: readonly string[],
): RecoveredToolCall[] {
	const calls: RecoveredToolCall[] = [];
	for (const segment of section.split(CALL_BEGIN).slice(1)) {
		const end = segment.indexOf(CALL_END);
		const call = parseGluedToolCall(
			end >= 0 ? segment.slice(0, end) : segment,
			availableTools,
		);
		if (call?.input) {
			calls.push({ toolName: call.toolName, input: JSON.parse(call.input) });
		}
	}
	return calls;
}

/**
 * Watches a reply's text for a tool-call section the server left in it.
 * `push` returns the text that is safe to show; from the first marker on,
 * text is held back. `finish` returns the calls read out of the held text,
 * or the held text itself when no call could be recovered from it.
 */
export function createLeakedToolCallFilter(availableTools: readonly string[]) {
	let held = "";
	let holding = false;
	/** The end of the last delta, when it could be the start of a marker. */
	let tail = "";

	return {
		push(text: string): string {
			if (holding) {
				held += text;
				return "";
			}
			const combined = tail + text;
			const marker = combined.indexOf(LEAK_MARKER);
			if (marker >= 0) {
				holding = true;
				held = combined.slice(marker);
				tail = "";
				return combined.slice(0, marker);
			}
			tail = "";
			for (
				let length = Math.min(LEAK_MARKER.length - 1, combined.length);
				length > 0;
				length--
			) {
				if (LEAK_MARKER.startsWith(combined.slice(-length))) {
					tail = combined.slice(-length);
					break;
				}
			}
			return combined.slice(0, combined.length - tail.length);
		},
		finish(options?: { recover?: boolean }): {
			text: string;
			calls: RecoveredToolCall[];
		} {
			if (!holding) {
				return { text: tail, calls: [] };
			}
			const calls =
				options?.recover === false
					? []
					: parseLeakedToolCalls(held, availableTools);
			return calls.length > 0 ? { text: "", calls } : { text: held, calls };
		},
	};
}
