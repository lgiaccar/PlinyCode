import type {
	ContentBlock,
	Message,
	TextContent,
	ToolResultContent,
} from "@plinycode/shared";

const MISSING_TOOL_RESULT_TEXT =
	"Tool execution was interrupted before a result was produced.";

export function addMissingToolResults(messages: Message[]): Message[] {
	const existingToolResultIds = collectToolResultIds(messages);
	const repaired: Message[] = [];
	const pendingMissingToolCalls = new Map<string, string>();
	let changed = false;

	const flushMissing = () => {
		if (pendingMissingToolCalls.size === 0) {
			return;
		}
		pushRepairedMessage(
			createMissingToolResultMessage(pendingMissingToolCalls),
		);
		pendingMissingToolCalls.clear();
		changed = true;
	};

	const pushRepairedMessage = (message: Message) => {
		const previous = repaired.at(-1);
		if (shouldMergeUserAfterToolResults(previous, message)) {
			repaired[repaired.length - 1] = {
				...previous,
				content: [
					...previous.content,
					...contentBlocksForUserMerge(message.content),
				],
			};
			changed = true;
			return;
		}
		repaired.push(message);
	};

	for (const message of messages) {
		if (isToolResultOnlyMessage(message)) {
			pushRepairedMessage(
				appendMissingToolResults(message, pendingMissingToolCalls),
			);
			if (pendingMissingToolCalls.size > 0) {
				pendingMissingToolCalls.clear();
				changed = true;
			}
			continue;
		}

		if (Array.isArray(message.content)) {
			const toolResults = message.content.filter(
				(block): block is ToolResultContent => block.type === "tool_result",
			);
			const otherBlocks = message.content.filter(
				(block) => block.type !== "tool_result",
			);

			if (toolResults.length > 0) {
				const toolResultMessage = appendMissingToolResults(
					{
						...message,
						role: "user",
						content: toolResults,
					},
					pendingMissingToolCalls,
				);
				pushRepairedMessage(toolResultMessage);
				if (pendingMissingToolCalls.size > 0) {
					pendingMissingToolCalls.clear();
				}
				changed = true;
			}

			if (otherBlocks.length > 0 || toolResults.length === 0) {
				if (toolResults.length === 0) {
					flushMissing();
				}
				const nextMessage =
					toolResults.length > 0
						? {
								...message,
								content: otherBlocks,
							}
						: message;
				pushRepairedMessage(nextMessage);
				if (nextMessage.role === "assistant") {
					trackMissingToolCalls(
						nextMessage,
						existingToolResultIds,
						pendingMissingToolCalls,
					);
				}
			}
			continue;
		}

		flushMissing();
		pushRepairedMessage(message);
	}

	flushMissing();
	return changed ? repaired : messages;
}

function appendMissingToolResults(
	message: Message,
	pendingMissingToolCalls: ReadonlyMap<string, string>,
): Message {
	if (pendingMissingToolCalls.size === 0 || !Array.isArray(message.content)) {
		return message;
	}
	return {
		...message,
		role: "user",
		content: [
			...message.content,
			...createMissingToolResultBlocks(pendingMissingToolCalls),
		],
	};
}

function shouldMergeUserAfterToolResults(
	previous: Message | undefined,
	next: Message,
): previous is Message & { content: ToolResultContent[] } {
	return (
		previous?.role === "user" &&
		next.role === "user" &&
		isToolResultOnlyMessage(previous) &&
		contentBlocksForUserMerge(next.content).length > 0
	);
}

function contentBlocksForUserMerge(
	content: Message["content"],
): ContentBlock[] {
	return typeof content === "string"
		? content.length > 0
			? [{ type: "text", text: content } satisfies TextContent]
			: []
		: content;
}

function collectToolResultIds(messages: Message[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "tool_result") {
				ids.add(block.tool_use_id);
			}
		}
	}
	return ids;
}

function isToolResultOnlyMessage(message: Message): boolean {
	return (
		message.role === "user" &&
		Array.isArray(message.content) &&
		message.content.length > 0 &&
		message.content.every((block) => block.type === "tool_result")
	);
}

function trackMissingToolCalls(
	message: Message,
	existingToolResultIds: Set<string>,
	pendingMissingToolCalls: Map<string, string>,
): void {
	if (!Array.isArray(message.content)) {
		return;
	}
	for (const block of message.content) {
		if (block.type !== "tool_use" || existingToolResultIds.has(block.id)) {
			continue;
		}
		pendingMissingToolCalls.set(block.id, block.name);
	}
}

function createMissingToolResultMessage(
	toolCalls: ReadonlyMap<string, string>,
): Message {
	return {
		role: "user",
		content: createMissingToolResultBlocks(toolCalls),
	};
}

function createMissingToolResultBlocks(
	toolCalls: ReadonlyMap<string, string>,
): ToolResultContent[] {
	return Array.from(toolCalls, ([toolUseId, toolName]) => ({
		type: "tool_result",
		tool_use_id: toolUseId,
		name: toolName,
		content: [
			{
				type: "text",
				text: formatMissingToolResultText(toolName),
			},
		],
		is_error: true,
	}));
}

function formatMissingToolResultText(toolName: string): string {
	return toolName
		? `${MISSING_TOOL_RESULT_TEXT} Tool: ${toolName}.`
		: MISSING_TOOL_RESULT_TEXT;
}
