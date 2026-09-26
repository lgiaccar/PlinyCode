/**
 * Per-source breakdown of a request's estimated context tokens, for the
 * "where did my context go" UI (ContextWindowSummary). Uses the same
 * char-based estimator as the rest of the context-window bar
 * (`estimateTokens`/`CHARS_PER_TOKEN`) so every number in the UI comes from
 * one consistent scale, and is proportionally rescaled to a real
 * provider-reported prompt token count when one is available so the parts
 * always sum to the displayed total.
 */

import { CHARS_PER_TOKEN, estimateTokens } from "./tokens";

export interface ContextBreakdownInput {
	/** The composed system prompt sent with the request (base prompt + any merged rules). */
	systemPrompt?: string;
	/**
	 * Text injected by registered `.clinerules`/global/remote-config rules,
	 * already merged into `systemPrompt` — reported separately so it can be
	 * attributed its own bucket instead of folding into "System Prompt".
	 */
	rulesText?: string;
	/** Text injected by an expanded skill (body + index) for this turn, if any. */
	skillsText?: string;
	/** Text injected by an expanded `/workflow` slash command for this turn, if any. */
	workflowsText?: string;
	/** The request's message list (conversation history + current turn). */
	messages: readonly unknown[];
}

export interface ContextBreakdownTokens {
	systemPrompt: number;
	rules: number;
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

/**
 * Splits an AgentMessage's parts into "conversation" (text, reasoning, tool
 * calls/results) and "other" (images, files, generated media) char counts.
 * Duck-typed against `AgentMessagePart` rather than importing the type, to
 * keep this module free of a dependency on `../agent`.
 */
function splitMessageChars(message: unknown): {
	conversation: number;
	other: number;
} {
	if (!isRecord(message)) {
		return { conversation: safeStringify(message).length, other: 0 };
	}
	const content = message.content;
	if (!Array.isArray(content)) {
		// No structured parts (e.g. a plain-text message shape) — the whole
		// message serializes as conversation.
		return { conversation: safeStringify(message).length, other: 0 };
	}
	let conversation = 0;
	let other = 0;
	for (const part of content) {
		if (!isRecord(part)) {
			conversation += safeStringify(part).length;
			continue;
		}
		switch (part.type) {
			case "image":
			case "file":
			case "media":
				other += safeStringify(part).length;
				break;
			default:
				conversation += safeStringify(part).length;
				break;
		}
	}
	return { conversation, other };
}

/**
 * Estimate the token breakdown of a request by source. Callers that already
 * have a real provider-reported prompt token count should pass it via
 * `scaleToInputTokens` so the parts are rescaled to sum to that value —
 * otherwise the parts sum to the (slightly over-)estimated raw total.
 */
export function estimateContextBreakdown(
	input: ContextBreakdownInput,
	scaleToInputTokens?: number,
): ContextBreakdownTokens {
	const rulesChars = input.rulesText?.length ?? 0;
	const skillsChars = input.skillsText?.length ?? 0;
	const workflowsChars = input.workflowsText?.length ?? 0;
	// The rules/skills/workflows text is already included verbatim in
	// systemPrompt (rules) or in the user message it was expanded into
	// (skills/workflows) — subtract it back out of the bucket it physically
	// lives in so sections stay disjoint and still sum to the whole request.
	const systemPromptChars = Math.max(
		0,
		(input.systemPrompt?.length ?? 0) - rulesChars,
	);

	let conversationChars = 0;
	let otherChars = 0;
	for (const message of input.messages) {
		const split = splitMessageChars(message);
		conversationChars += split.conversation;
		otherChars += split.other;
	}
	conversationChars = Math.max(
		0,
		conversationChars - skillsChars - workflowsChars,
	);

	const raw: ContextBreakdownTokens = {
		systemPrompt: estimateTokens(systemPromptChars),
		rules: rulesChars > 0 ? estimateTokens(rulesChars) : 0,
		skills: skillsChars > 0 ? estimateTokens(skillsChars) : 0,
		workflows: workflowsChars > 0 ? estimateTokens(workflowsChars) : 0,
		conversation: estimateTokens(conversationChars),
		other: otherChars > 0 ? estimateTokens(otherChars) : 0,
	};

	if (scaleToInputTokens === undefined || scaleToInputTokens <= 0) {
		return raw;
	}
	const rawTotal =
		raw.systemPrompt +
		raw.rules +
		raw.skills +
		raw.workflows +
		raw.conversation +
		raw.other;
	if (rawTotal <= 0) {
		return raw;
	}
	const scale = scaleToInputTokens / rawTotal;
	return {
		systemPrompt: Math.round(raw.systemPrompt * scale),
		rules: Math.round(raw.rules * scale),
		skills: Math.round(raw.skills * scale),
		workflows: Math.round(raw.workflows * scale),
		conversation: Math.round(raw.conversation * scale),
		other: Math.round(raw.other * scale),
	};
}

// Re-exported so callers that only need the breakdown don't need a second
// import from ./tokens for the shared scale constant.
export { CHARS_PER_TOKEN };
