/**
 * Per-source breakdown of a request's estimated context tokens, for the
 * "where did my context go" UI (ContextWindowSummary). Uses the same
 * char-based estimator as the rest of the context-window bar
 * (`estimateTokens`, at the model's calibrated characters-per-token ratio
 * when one is passed) so every number in the UI comes from one consistent
 * scale, and is proportionally rescaled to a real provider-reported prompt
 * token count when one is available so the parts always sum to the
 * displayed total.
 */

import {
	CHARS_PER_TOKEN,
	estimateMeasuredTokens,
	estimateTokens,
	measureForTokenEstimate,
} from "./tokens";

/** Name of the engine's `skills` tool, whose results are skill bodies. */
export const SKILLS_TOOL_NAME = "skills";
/**
 * Where the `skills` tool's description starts listing the configured
 * skills (core's createSkillsTool). The listing is counted as skills, the
 * rest of the tool's definition as tools.
 */
export const SKILLS_LISTING_PREFIX = " Available skills: ";
/**
 * Pasted bodies shorter than this are not looked for: a short body matches
 * ordinary text by accident.
 */
const MIN_PASTED_BODY_CHARS = 32;

/**
 * What parts of a request came from where, beyond what the request itself
 * shows. Supplied by the session (rules, memory) and the host (the bodies a
 * slash command pastes) before each model call, as request metadata.
 */
export interface ContextSourceTexts {
	/**
	 * Text injected by registered `.clinerules`/global/remote-config rules,
	 * already merged into `systemPrompt` — reported separately so it can be
	 * attributed its own bucket instead of folding into "System Prompt".
	 */
	rulesText?: string;
	/** The memory section appended to the system prompt; counted only when the prompt contains it. */
	memoryText?: string;
	/**
	 * Bodies of skills a slash command pastes into a user message (the
	 * built-in commands). Each occurrence in a user message counts as skills.
	 */
	skillTexts?: readonly string[];
	/** Bodies of workflows a slash command pastes into a user message. */
	workflowTexts?: readonly string[];
}

export interface ContextBreakdownInput extends ContextSourceTexts {
	/** The composed system prompt sent with the request (base prompt + any merged rules). */
	systemPrompt?: string;
	/** The tool definitions sent with the request (name, description, input schema). */
	tools?: readonly unknown[];
	/** The request's message list (conversation history + current turn). */
	messages: readonly unknown[];
	/** The model's calibrated characters per token; CHARS_PER_TOKEN when omitted. */
	charsPerToken?: number;
}

export interface ContextBreakdownTokens {
	systemPrompt: number;
	rules: number;
	memory: number;
	tools: number;
	skills: number;
	workflows: number;
	conversation: number;
	other: number;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value ?? "");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let index = text.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = text.indexOf(needle, index + needle.length);
	}
	return count;
}

function pastedBodies(texts: readonly string[] | undefined): string[] {
	if (!texts) {
		return [];
	}
	return [...new Set(texts)].filter(
		(text) => text.length >= MIN_PASTED_BODY_CHARS,
	);
}

/** Characters of `text` taken up by occurrences of `bodies`. */
function pastedChars(text: string, bodies: readonly string[]): number {
	let chars = 0;
	for (const body of bodies) {
		chars += countOccurrences(text, body) * body.length;
	}
	return chars;
}

/**
 * Splits the tool definitions into the `skills` tool's listing of skills
 * and everything else.
 */
function splitToolChars(tools: readonly unknown[] | undefined): {
	tools: number;
	skills: number;
} {
	let toolChars = 0;
	let skillChars = 0;
	for (const tool of tools ?? []) {
		const chars = safeStringify(tool).length;
		if (
			isRecord(tool) &&
			tool.name === SKILLS_TOOL_NAME &&
			typeof tool.description === "string"
		) {
			const listingStart = tool.description.indexOf(SKILLS_LISTING_PREFIX);
			if (listingStart !== -1) {
				const listing = Math.min(chars, tool.description.length - listingStart);
				skillChars += listing;
				toolChars += chars - listing;
				continue;
			}
		}
		toolChars += chars;
	}
	return { tools: toolChars, skills: skillChars };
}

/**
 * Splits the messages into conversation (text, reasoning, tool calls and
 * results), skills (the `skills` tool's results and pasted skill bodies),
 * workflows (pasted workflow bodies) and other (images, files, generated
 * media). Duck-typed against `AgentMessagePart` rather than importing the
 * type, to keep this module free of a dependency on `../agent`.
 */
function splitMessageChars(
	messages: readonly unknown[],
	skillBodies: readonly string[],
	workflowBodies: readonly string[],
): {
	conversation: number;
	skills: number;
	workflows: number;
	otherParts: unknown[];
} {
	let conversation = 0;
	let skills = 0;
	let workflows = 0;
	const otherParts: unknown[] = [];
	for (const message of messages) {
		if (!isRecord(message) || !Array.isArray(message.content)) {
			// No structured parts (e.g. a plain-text message shape) — the whole
			// message serializes as conversation.
			conversation += safeStringify(message).length;
			continue;
		}
		const isUser = message.role === "user";
		for (const part of message.content) {
			if (!isRecord(part)) {
				conversation += safeStringify(part).length;
				continue;
			}
			switch (part.type) {
				case "image":
				case "file":
				case "media":
					// Binary payloads count as images, not as their base64 text.
					otherParts.push(part);
					break;
				case "tool-result": {
					const chars = safeStringify(part).length;
					if (part.toolName === SKILLS_TOOL_NAME) {
						skills += chars;
					} else {
						conversation += chars;
					}
					break;
				}
				case "text": {
					const chars = safeStringify(part).length;
					if (!isUser || typeof part.text !== "string") {
						conversation += chars;
						break;
					}
					const pastedSkills = Math.min(
						chars,
						pastedChars(part.text, skillBodies),
					);
					const pastedWorkflows = Math.min(
						chars - pastedSkills,
						pastedChars(part.text, workflowBodies),
					);
					skills += pastedSkills;
					workflows += pastedWorkflows;
					conversation += chars - pastedSkills - pastedWorkflows;
					break;
				}
				default:
					conversation += safeStringify(part).length;
					break;
			}
		}
	}
	return { conversation, skills, workflows, otherParts };
}

function bucketTokens(chars: number, charsPerToken: number): number {
	return chars > 0 ? estimateTokens(chars, charsPerToken) : 0;
}

/**
 * Estimate the token breakdown of a request by source. Callers that already
 * have a real provider-reported prompt token count should pass it via
 * `scaleToInputTokens` so the parts are rescaled to sum to that value —
 * otherwise the parts sum to the raw estimated total.
 */
export function estimateContextBreakdown(
	input: ContextBreakdownInput,
	scaleToInputTokens?: number,
): ContextBreakdownTokens {
	const charsPerToken = input.charsPerToken ?? CHARS_PER_TOKEN;
	const systemPrompt = input.systemPrompt ?? "";
	const rulesChars = input.rulesText?.length ?? 0;
	// The memory section is the host's text appended to the prompt; count it
	// only when it is really there, so a stale one cannot eat the prompt.
	const memoryChars =
		input.memoryText && systemPrompt.includes(input.memoryText)
			? input.memoryText.length
			: 0;
	// The rules and memory text is already included verbatim in systemPrompt —
	// subtract it back out so sections stay disjoint and still sum to the
	// whole request.
	const systemPromptChars = Math.max(
		0,
		systemPrompt.length - rulesChars - memoryChars,
	);
	const toolChars = splitToolChars(input.tools);
	const messageChars = splitMessageChars(
		input.messages,
		pastedBodies(input.skillTexts),
		pastedBodies(input.workflowTexts),
	);

	const raw: ContextBreakdownTokens = {
		systemPrompt: estimateTokens(systemPromptChars, charsPerToken),
		rules: bucketTokens(rulesChars, charsPerToken),
		memory: bucketTokens(memoryChars, charsPerToken),
		tools: bucketTokens(toolChars.tools, charsPerToken),
		skills: bucketTokens(toolChars.skills + messageChars.skills, charsPerToken),
		workflows: bucketTokens(messageChars.workflows, charsPerToken),
		conversation: estimateTokens(messageChars.conversation, charsPerToken),
		other:
			messageChars.otherParts.length > 0
				? estimateMeasuredTokens(
						measureForTokenEstimate(messageChars.otherParts),
						charsPerToken,
					)
				: 0,
	};

	if (scaleToInputTokens === undefined || scaleToInputTokens <= 0) {
		return raw;
	}
	const keys = Object.keys(raw) as Array<keyof ContextBreakdownTokens>;
	const rawTotal = keys.reduce((total, key) => total + raw[key], 0);
	if (rawTotal <= 0) {
		return raw;
	}
	const scale = scaleToInputTokens / rawTotal;
	const scaled = { ...raw };
	for (const key of keys) {
		scaled[key] = Math.round(raw[key] * scale);
	}
	return scaled;
}
