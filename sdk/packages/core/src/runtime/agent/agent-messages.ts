import type {
	AgentMessage,
	AgentMessagePart,
	AgentModelRequest,
	AgentUsage,
} from "@plinycode/shared";
import { estimateTokens } from "@plinycode/shared";
import { nanoid } from "nanoid";

// Local `createUID` helper. The clinee source imports this from
// `@plinycode/shared` (see `packages/shared/dist/identifier.ts`), but
// sdk-re's shared package does not expose it yet. Inlining here keeps
// PLAN.md Step 1 scoped to `packages/agents/src/` and matches the
// exact clinee implementation (`${prefix}_${nanoid(length)}`).
export function createUID(prefix: string, length = 8): string {
	return `${prefix}_${nanoid(length)}`;
}

export type AgentRunInput = string | AgentMessage | readonly AgentMessage[];

function safeJsonSize(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return String(value).length;
	}
}

function getOutputSize(output: unknown): number {
	if (typeof output === "string") {
		return output.length;
	}
	return safeJsonSize(output);
}

export function summarizeModelRequest(
	request: AgentModelRequest,
): Record<string, unknown> {
	let textChars = request.systemPrompt?.length ?? 0;
	let toolResultCount = 0;
	let toolResultChars = 0;
	let maxToolResultChars = 0;
	for (const message of request.messages) {
		for (const part of message.content) {
			switch (part.type) {
				case "text":
					textChars += part.text.length;
					break;
				case "reasoning":
					textChars += part.text.length;
					break;
				case "file":
					textChars += part.content.length;
					break;
				case "tool-call":
					textChars += safeJsonSize(part.input);
					break;
				case "tool-result": {
					const outputChars = getOutputSize(part.output);
					toolResultCount += 1;
					toolResultChars += outputChars;
					maxToolResultChars = Math.max(maxToolResultChars, outputChars);
					textChars += outputChars;
					break;
				}
			}
		}
	}

	return {
		messageCount: request.messages.length,
		toolSchemaCount: request.tools.length,
		systemPromptChars: request.systemPrompt?.length ?? 0,
		requestJsonChars: safeJsonSize({
			systemPrompt: request.systemPrompt,
			messages: request.messages,
			tools: request.tools,
			options: request.options,
		}),
		visibleTextChars: textChars,
		estimatedTextTokens: estimateTokens(textChars),
		toolResultCount,
		toolResultChars,
		maxToolResultChars,
	};
}

export const DEFAULT_USAGE: AgentUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
};

export function createMessage(
	role: AgentMessage["role"],
	content: AgentMessagePart[],
	metadata?: Record<string, unknown>,
): AgentMessage {
	return {
		id: createUID("msg"),
		role,
		content,
		createdAt: Date.now(),
		metadata,
	};
}

export function cloneUsage(usage: AgentUsage): AgentUsage {
	return { ...usage };
}

export function cloneMessages(
	messages: readonly AgentMessage[],
): AgentMessage[] {
	return messages.map((message) => ({
		...message,
		content: message.content.map((part: AgentMessagePart) => ({ ...part })),
		metadata: message.metadata ? { ...message.metadata } : undefined,
		modelInfo: message.modelInfo ? { ...message.modelInfo } : undefined,
		metrics: message.metrics ? { ...message.metrics } : undefined,
	}));
}

export function usageDelta(
	start: AgentUsage,
	end: AgentUsage,
): NonNullable<AgentMessage["metrics"]> | undefined {
	const inputTokens = Math.max(
		0,
		(end.inputTokens ?? 0) - (start.inputTokens ?? 0),
	);
	const outputTokens = Math.max(
		0,
		(end.outputTokens ?? 0) - (start.outputTokens ?? 0),
	);
	const cacheReadTokens = Math.max(
		0,
		(end.cacheReadTokens ?? 0) - (start.cacheReadTokens ?? 0),
	);
	const cacheWriteTokens = Math.max(
		0,
		(end.cacheWriteTokens ?? 0) - (start.cacheWriteTokens ?? 0),
	);
	const reasoningTokenCount = Math.max(
		0,
		(end.reasoningTokenCount ?? 0) - (start.reasoningTokenCount ?? 0),
	);
	const startCost = start.totalCost ?? 0;
	const endCost = end.totalCost ?? 0;
	const cost = Math.max(0, endCost - startCost);
	if (
		inputTokens === 0 &&
		outputTokens === 0 &&
		cacheReadTokens === 0 &&
		cacheWriteTokens === 0 &&
		reasoningTokenCount === 0 &&
		cost === 0
	) {
		return undefined;
	}
	return {
		inputTokens: inputTokens > 0 ? inputTokens : 0,
		outputTokens: outputTokens > 0 ? outputTokens : 0,
		cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : 0,
		cacheWriteTokens: cacheWriteTokens > 0 ? cacheWriteTokens : 0,
		...(reasoningTokenCount > 0 ? { reasoningTokenCount } : {}),
		...(cost > 0 ? { cost } : {}),
	};
}

export function textFromMessage(message: AgentMessage | undefined): string {
	if (!message) {
		return "";
	}
	return message.content
		.filter(
			(
				part: AgentMessagePart,
			): part is Extract<AgentMessagePart, { type: "text" }> =>
				part.type === "text",
		)
		.map((part: Extract<AgentMessagePart, { type: "text" }>) => part.text)
		.join("");
}

export function textFromToolMessage(message: AgentMessage | undefined): string {
	const result = message?.content.find(
		(part): part is Extract<AgentMessagePart, { type: "tool-result" }> =>
			part.type === "tool-result",
	);
	if (!result || result.isError) {
		return "";
	}
	if (typeof result.output === "string") {
		return result.output;
	}
	try {
		return JSON.stringify(result.output);
	} catch {
		return String(result.output);
	}
}

export function normalizeInput(input: AgentRunInput): AgentMessage[] {
	if (typeof input === "string") {
		return [createMessage("user", [{ type: "text", text: input }])];
	}
	if (Array.isArray(input)) {
		return cloneMessages(input);
	}
	return cloneMessages([input as AgentMessage]);
}
