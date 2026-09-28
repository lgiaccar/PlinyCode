import {
	type ContentBlock,
	createMediaBudgetState,
	IMAGE_OMITTED_PLACEHOLDER,
	type ImageContent,
	type MediaBudgetState,
	type Message,
	type ResolvedMediaBudget,
	type TextContent,
	type ToolResultContent,
	validateAndReserveImageMedia,
} from "@plinycode/shared";
import {
	isImageContentLike,
	isImageContentWithData,
	isStructuredToolResultEntry,
} from "./content-entries";

export function applyMediaBudget(
	messages: Message[],
	budget: ResolvedMediaBudget,
): Message[] {
	if (
		budget.maxImageEncodedBytes === Number.POSITIVE_INFINITY &&
		budget.maxImageDecodedBytes === Number.POSITIVE_INFINITY &&
		budget.maxTotalMediaBytes === Number.POSITIVE_INFINITY
	) {
		return messages;
	}

	const state = createMediaBudgetState();
	let changed = false;
	const next = messages.map((message) => {
		if (!Array.isArray(message.content)) {
			return message;
		}
		let contentChanged = false;
		const content = message.content.map((block) => {
			const out = applyMediaBudgetToBlock(block, budget, state);
			if (out !== block) {
				contentChanged = true;
			}
			return out;
		});
		if (!contentChanged) {
			return message;
		}
		changed = true;
		return { ...message, content };
	});

	return changed ? next : messages;
}

function applyMediaBudgetToBlock(
	block: ContentBlock,
	budget: ResolvedMediaBudget,
	state: MediaBudgetState,
): ContentBlock {
	if (isImageContentLike(block)) {
		return limitImageContent(block, budget, state);
	}

	if (block.type !== "tool_result" || typeof block.content === "string") {
		return block;
	}

	let changed = false;
	const content = block.content.map((entry) => {
		const out = applyMediaBudgetToToolResultEntry(entry, budget, state);
		if (out !== entry) {
			changed = true;
		}
		return out as (typeof block.content)[number];
	});

	return changed
		? { ...block, content: content as ToolResultContent["content"] }
		: block;
}

function applyMediaBudgetToToolResultEntry(
	entry: unknown,
	budget: ResolvedMediaBudget,
	state: MediaBudgetState,
): unknown {
	if (isImageContentLike(entry)) {
		return limitImageContent(entry, budget, state);
	}
	if (isStructuredToolResultEntry(entry)) {
		return limitNestedMedia(entry, budget, state);
	}
	return entry;
}

function limitNestedMedia(
	value: unknown,
	budget: ResolvedMediaBudget,
	state: MediaBudgetState,
): unknown {
	if (isImageContentLike(value)) {
		const limited = limitImageContent(value, budget, state);
		return limited.type === "text" ? limited.text : limited;
	}

	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item) => {
			const out = limitNestedMedia(item, budget, state);
			if (out !== item) {
				changed = true;
			}
			return out;
		});
		return changed ? next : value;
	}

	if (value !== null && typeof value === "object") {
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			const out = limitNestedMedia(item, budget, state);
			if (out !== item) {
				changed = true;
			}
			next[key] = out;
		}
		return changed ? next : value;
	}

	return value;
}

function limitImageContent(
	image: unknown,
	budget: ResolvedMediaBudget,
	state: MediaBudgetState,
): ImageContent | TextContent {
	if (!isImageContentWithData(image)) {
		return { type: "text", text: IMAGE_OMITTED_PLACEHOLDER };
	}

	const validation = validateAndReserveImageMedia(
		image.mediaType,
		image.data,
		{
			maxImageEncodedBytes: budget.maxImageEncodedBytes,
			maxImageDecodedBytes: budget.maxImageDecodedBytes,
			maxTotalMediaBytes: budget.maxTotalMediaBytes,
		},
		state,
	);
	if (!validation.ok) {
		return { type: "text", text: IMAGE_OMITTED_PLACEHOLDER };
	}

	return {
		...image,
		data: validation.base64,
		mediaType: validation.mediaType,
	};
}
