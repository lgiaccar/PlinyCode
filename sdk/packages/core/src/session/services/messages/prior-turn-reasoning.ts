import type { AgentMessage, AgentMessagePart } from "@plinycode/shared";
import { isUserRunMessage } from "../../user-run-messages";

const INLINE_THINK_BLOCK = /<think>[\s\S]*?<\/think>\s*/g;

/**
 * Drops reasoning the model produced in earlier user turns before a request
 * goes out.
 *
 * Every assistant message keeps its reasoning in history (the UI replays it),
 * but resending it makes each request carry all past thinking: the
 * openai-compatible provider puts it back on the wire as `reasoning_content`
 * on every earlier assistant message, and models that think inline store
 * `<think>` blocks as plain text. Once a turn is over the model has already
 * acted on that reasoning, so only the current turn's reasoning is kept
 * (some models need it to continue a tool-call chain).
 *
 * Signed reasoning (Anthropic thinking blocks carrying a signature or
 * redacted data) is left alone: the provider validates and caches it.
 */
export function dropPriorTurnReasoning(
	messages: readonly AgentMessage[],
): AgentMessage[] {
	const currentTurnStart = findCurrentTurnStart(messages);
	if (currentTurnStart <= 0) {
		return [...messages];
	}
	const out: AgentMessage[] = [];
	for (const [index, message] of messages.entries()) {
		if (index >= currentTurnStart || message.role !== "assistant") {
			out.push(message);
			continue;
		}
		const content = stripReasoningParts(message.content);
		if (content === message.content) {
			out.push(message);
		} else if (content.length > 0) {
			out.push({ ...message, content });
		}
		// An assistant message that held nothing but reasoning is dropped.
	}
	return out;
}

function findCurrentTurnStart(messages: readonly AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (isUserRunMessage(messages[index])) {
			return index;
		}
	}
	return -1;
}

function stripReasoningParts(parts: AgentMessagePart[]): AgentMessagePart[] {
	let changed = false;
	const out: AgentMessagePart[] = [];
	for (const part of parts) {
		if (part.type === "reasoning" && !isSignedReasoning(part)) {
			changed = true;
			continue;
		}
		if (part.type === "text" && part.text.includes("</think>")) {
			const text = part.text.replace(INLINE_THINK_BLOCK, "");
			if (text !== part.text) {
				changed = true;
				if (text.trim().length > 0) {
					out.push({ ...part, text });
				}
				continue;
			}
		}
		out.push(part);
	}
	return changed ? out : parts;
}

function isSignedReasoning(
	part: Extract<AgentMessagePart, { type: "reasoning" }>,
): boolean {
	const metadata = part.metadata as Record<string, unknown> | undefined;
	return (
		part.redacted === true ||
		typeof metadata?.signature === "string" ||
		typeof metadata?.redactedData === "string"
	);
}
