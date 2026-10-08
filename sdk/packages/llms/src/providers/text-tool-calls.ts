/**
 * Tool calls a model wrote into its reply text instead of making them.
 *
 * Open models, and Claude-distilled ones in particular, sometimes fall back
 * to a tool-call syntax from their training data and write it as plain text:
 *
 * - Anthropic's XML, optionally inside a `<function_calls>` block:
 *   `<invoke name="read_files"><parameter name="files">[…]</parameter></invoke>`
 *   (seen from Kimi K2.6 on its first reply in FreeAuto)
 * - Qwen3-Coder's XML: `<tool_call><function=read_files><parameter=files>[…]</parameter></function></tool_call>`
 * - Hermes JSON: `<tool_call>{"name": "read_files", "arguments": {…}}</tool_call>`
 * - Kimi's own tokens, which its server failed to parse (`kimi-tool-calls.ts`)
 *
 * Nothing runs, and the turn ends on what looks like an answer. The filter
 * here holds such a section back while the reply streams and, once the reply
 * is complete, turns it into the tool calls it was meant to be. It errs on the
 * side of leaving text alone: a section inside a code fence, followed by more
 * prose, naming a tool that does not exist, or with arguments it cannot read,
 * is shown as the text it arrived as.
 */

import {
	parseLeakedToolCalls,
	type RecoveredToolCall,
	resolveMisnamedTool,
} from "./kimi-tool-calls";

export interface TextToolCallTool {
	name: string;
	inputSchema?: Record<string, unknown>;
}

/** The starts of a tool-call section. */
const KIMI_MARKER = "<|tool_call";
/** Claude's XML namespace prefix; the tags appear with and without it. */
const NS = ["antml", ":"].join("");
const XML_MARKERS = [
	"<function_calls>",
	`<${NS}function_calls>`,
	"<invoke name=",
	`<${NS}invoke name=`,
	"<tool_call>",
];
const MARKERS = [KIMI_MARKER, ...XML_MARKERS];

const INVOKE =
	/<(antml:)?invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/\1invoke>/g;
const INVOKE_PARAMETER =
	/<(antml:)?parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/\1parameter>/g;
const QWEN_FUNCTION = /<function=([^>\s]+)\s*>([\s\S]*?)<\/function>/g;
const QWEN_PARAMETER = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g;
const HERMES_CALL = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
/** Wrapper tags that may surround the calls and carry nothing themselves. */
const WRAPPER_TAG = /<\/?(?:antml:)?function_calls>|<\/?tool_call>/g;

function propertyType(
	tool: TextToolCallTool | undefined,
	parameter: string,
): unknown {
	const properties = tool?.inputSchema?.properties;
	if (!properties || typeof properties !== "object") {
		return undefined;
	}
	const schema = (properties as Record<string, unknown>)[parameter];
	return schema && typeof schema === "object"
		? (schema as { type?: unknown }).type
		: undefined;
}

/** JSON, also when a model wrote Windows paths with single backslashes. */
function parseJsonLenient(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		try {
			return JSON.parse(text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\"));
		} catch {
			return undefined;
		}
	}
}

/**
 * A parameter's value as the tool expects it. These formats write strings
 * as they are and everything else as JSON, so the tool's schema decides:
 * a string parameter keeps the raw text, any other is read as JSON.
 */
function parameterValue(
	raw: string,
	type: unknown,
): { ok: true; value: unknown } | { ok: false } {
	const text = raw.replace(/^\n/, "").replace(/\n$/, "");
	if (type === "string") {
		return { ok: true, value: text };
	}
	const parsed = parseJsonLenient(text.trim());
	if (parsed !== undefined) {
		return { ok: true, value: parsed };
	}
	// No schema to go by: a value that is not JSON is a string.
	return type === undefined ? { ok: true, value: text } : { ok: false };
}

function resolveTool(
	name: string,
	tools: readonly TextToolCallTool[],
): TextToolCallTool | undefined {
	const names = tools.map((tool) => tool.name);
	const resolved = names.includes(name)
		? name
		: resolveMisnamedTool(name, names);
	return resolved ? tools.find((tool) => tool.name === resolved) : undefined;
}

function readParameters(
	body: string,
	pattern: RegExp,
	nameGroup: number,
	valueGroup: number,
	tool: TextToolCallTool,
): Record<string, unknown> | undefined {
	const input: Record<string, unknown> = {};
	for (const match of body.matchAll(pattern)) {
		const name = match[nameGroup];
		const value = parameterValue(match[valueGroup], propertyType(tool, name));
		if (!value.ok) {
			return undefined;
		}
		input[name] = value.value;
	}
	// Anything but whitespace between the parameters is not part of a call.
	return body.replace(pattern, "").trim() ? undefined : input;
}

/**
 * The calls in an XML or Hermes tool-call section. All or nothing: the
 * section must consist of calls (and their wrappers) only, each naming an
 * available tool with arguments that can be read; otherwise none are run.
 */
export function parseTextToolCalls(
	section: string,
	tools: readonly TextToolCallTool[],
): RecoveredToolCall[] {
	const calls: Array<{ at: number; call: RecoveredToolCall }> = [];
	let rest = section;
	const formats: Array<{
		pattern: RegExp;
		read: (match: RegExpMatchArray) => RecoveredToolCall | undefined;
	}> = [
		{
			pattern: INVOKE,
			read: (match) => {
				const tool = resolveTool(match[2], tools);
				const input =
					tool && readParameters(match[3], INVOKE_PARAMETER, 2, 3, tool);
				return tool && input ? { toolName: tool.name, input } : undefined;
			},
		},
		{
			pattern: QWEN_FUNCTION,
			read: (match) => {
				const tool = resolveTool(match[1], tools);
				const input =
					tool && readParameters(match[2], QWEN_PARAMETER, 1, 2, tool);
				return tool && input ? { toolName: tool.name, input } : undefined;
			},
		},
		{
			pattern: HERMES_CALL,
			read: (match) => {
				const parsed = parseJsonLenient(match[1]) as
					| { name?: unknown; arguments?: unknown; parameters?: unknown }
					| undefined;
				const tool =
					typeof parsed?.name === "string"
						? resolveTool(parsed.name, tools)
						: undefined;
				const args = parsed?.arguments ?? parsed?.parameters ?? {};
				const input = typeof args === "string" ? parseJsonLenient(args) : args;
				return tool &&
					input &&
					typeof input === "object" &&
					!Array.isArray(input)
					? { toolName: tool.name, input: input as Record<string, unknown> }
					: undefined;
			},
		},
	];
	for (const { pattern, read } of formats) {
		for (const match of section.matchAll(pattern)) {
			const call = read(match);
			if (!call) {
				return [];
			}
			calls.push({ at: match.index ?? 0, call });
		}
		rest = rest.replace(pattern, "");
	}
	if (rest.replace(WRAPPER_TAG, "").trim()) {
		return [];
	}
	return calls.sort((a, b) => a.at - b.at).map(({ call }) => call);
}

/** Code fences opened and not yet closed in `text`, counted by parity. */
function fenceOpen(text: string, wasOpen: boolean): boolean {
	const fences = text.match(/```/g)?.length ?? 0;
	return fences % 2 === 1 ? !wasOpen : wasOpen;
}

/**
 * Watches a reply's text for a tool-call section. `push` returns the text
 * that is safe to show; from the first marker on, text is held back. `finish`
 * returns the calls read out of the held text, or the held text itself when
 * no call could be recovered from it.
 */
export function createTextToolCallFilter(tools: readonly TextToolCallTool[]) {
	const toolNames = tools.map((tool) => tool.name);
	const longestMarker = Math.max(...MARKERS.map((marker) => marker.length));
	let held = "";
	let holding = false;
	/** The end of the last delta, when it could be the start of a marker. */
	let tail = "";
	/** Whether the text shown so far leaves a code fence open. */
	let inFence = false;

	/** The first marker outside a code fence, given the fence state at the start of `text`. */
	const findMarker = (text: string): number => {
		let fenceOpenHere = inFence;
		let from = 0;
		while (from < text.length) {
			const positions = MARKERS.map((marker) => text.indexOf(marker, from))
				.filter((position) => position >= 0)
				.sort((a, b) => a - b);
			const marker = positions[0];
			if (marker === undefined) {
				return -1;
			}
			fenceOpenHere = fenceOpen(text.slice(from, marker), fenceOpenHere);
			if (!fenceOpenHere) {
				return marker;
			}
			from = marker + 1;
		}
		return -1;
	};

	return {
		push(text: string): string {
			if (holding) {
				held += text;
				return "";
			}
			const combined = tail + text;
			const marker = findMarker(combined);
			if (marker >= 0) {
				holding = true;
				held = combined.slice(marker);
				tail = "";
				return combined.slice(0, marker);
			}
			tail = "";
			for (
				let length = Math.min(longestMarker - 1, combined.length);
				length > 0;
				length--
			) {
				const end = combined.slice(-length);
				if (MARKERS.some((candidate) => candidate.startsWith(end))) {
					tail = end;
					break;
				}
			}
			const shown = combined.slice(0, combined.length - tail.length);
			inFence = fenceOpen(shown, inFence);
			return shown;
		},
		/**
		 * `recover: false` shows the held text instead, for a reply that failed
		 * or was cut short. `hadToolCalls` says the reply also made real tool
		 * calls; text-written calls next to them are left as text.
		 */
		finish(options?: { recover?: boolean; hadToolCalls?: boolean }): {
			text: string;
			calls: RecoveredToolCall[];
		} {
			if (!holding) {
				return { text: tail, calls: [] };
			}
			if (options?.recover === false) {
				return { text: held, calls: [] };
			}
			const calls = held.startsWith(KIMI_MARKER)
				? parseLeakedToolCalls(held, toolNames)
				: options?.hadToolCalls
					? []
					: parseTextToolCalls(held, tools);
			return calls.length > 0 ? { text: "", calls } : { text: held, calls };
		},
	};
}
