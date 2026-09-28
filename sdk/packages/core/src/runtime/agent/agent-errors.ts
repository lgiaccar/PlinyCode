import type { AgentModelOutputLimit } from "@plinycode/shared";

const MAX_TOKENS_INCOMPLETE_TURN_MESSAGE =
	"Model reached the maximum output token limit before completing the turn";

const OUTPUT_LIMIT_SOURCE_LABELS: Record<
	AgentModelOutputLimit["source"],
	string
> = {
	setting: "Max Tokens setting",
	default: "default cap, no Max Tokens set",
	model_limit: "model output limit",
	remaining_context: "remaining context window",
	unknown: "unknown source",
};

function formatTokenCount(value: number | undefined): string | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.round(value).toLocaleString("en-US")
		: undefined;
}

/**
 * Builds the max-tokens failure message with the model and the sizes involved,
 * so the user can tell which setting to change. The fixed first sentence is
 * kept as a stable prefix for callers that match on it.
 */
export function formatMaxTokensIncompleteTurnMessage(details: {
	outputLimit?: AgentModelOutputLimit;
	modelId?: string;
	outputTokens?: number;
	inputTokens?: number;
}): string {
	const { outputLimit } = details;
	const modelId = outputLimit?.modelId ?? details.modelId;
	const facts: string[] = [];
	const output = formatTokenCount(details.outputTokens);
	if (output) {
		facts.push(`${output} output tokens`);
	}
	const cap = formatTokenCount(outputLimit?.maxTokens);
	if (cap && outputLimit) {
		facts.push(
			`cap ${cap} [${OUTPUT_LIMIT_SOURCE_LABELS[outputLimit.source]}]`,
		);
	}
	const input =
		formatTokenCount(details.inputTokens) ??
		formatTokenCount(outputLimit?.estimatedInputTokens);
	const contextWindow = formatTokenCount(outputLimit?.contextWindow);
	if (input) {
		facts.push(
			contextWindow
				? `input ≈${input} / context window ${contextWindow} tokens`
				: `input ≈${input} tokens`,
		);
	}
	const modelMax = formatTokenCount(outputLimit?.modelMaxOutputTokens);
	if (modelMax && outputLimit?.source !== "model_limit") {
		facts.push(`model max output ${modelMax}`);
	}
	const subject = modelId ? `model ${modelId}` : undefined;
	const detailText = [subject, facts.join(", ")].filter(Boolean).join(": ");

	let hint: string;
	switch (outputLimit?.source) {
		case "remaining_context":
			hint =
				"The conversation leaves too little room for output; compact the task or start a new one.";
			break;
		case "model_limit":
			hint =
				"This is the model's own output limit; switch to a model with a larger output limit or ask for smaller steps.";
			break;
		case "setting":
		case "default":
			hint =
				"Increase Max Tokens in the model settings, or ask for smaller steps.";
			break;
		default:
			hint =
				"Increase Max Tokens in the model settings, switch to a model with a larger output limit, or ask for smaller steps.";
	}
	return detailText
		? `${MAX_TOKENS_INCOMPLETE_TURN_MESSAGE} (${detailText}). ${hint}`
		: `${MAX_TOKENS_INCOMPLETE_TURN_MESSAGE}. ${hint}`;
}

/**
 * Terminal message when a context-window overflow cannot be recovered because
 * there is no conversation history to compact — the system prompt, tools, and
 * current input alone exceed the window.
 */
export const CONTEXT_WINDOW_OVERFLOW_NOTHING_TO_COMPACT_MESSAGE =
	"The request exceeds the model's context window and there is no conversation history to compact — the system prompt, tools, and current input alone are too large. Reduce attached content or switch to a model with a larger context window.";

/**
 * Terminal message when a context-window overflow persists after the runtime
 * already compacted the conversation and retried once.
 */
export const CONTEXT_WINDOW_OVERFLOW_RECOVERY_FAILED_MESSAGE =
	"The conversation still exceeds the model's context window after compacting it. Start a new session or switch to a model with a larger context window.";

/**
 * Terminal message when no compaction pipeline is available to recover from a
 * context-window overflow (e.g. compaction disabled).
 */
export const CONTEXT_WINDOW_OVERFLOW_NO_RECOVERY_MESSAGE =
	"The conversation exceeds the model's context window. Compact the conversation, start a new session, or switch to a model with a larger context window.";

/** Thrown when overflow recovery cannot proceed; carries the terminal text. */
export class ContextWindowOverflowError extends Error {
	constructor(message: string, providerError: string | undefined) {
		super(
			providerError?.trim()
				? `${message} (provider reported: ${providerError.trim()})`
				: message,
		);
		this.name = "ContextWindowOverflowError";
	}
}

export class ControlledStopError extends Error {
	readonly reason?: string;

	constructor(reason?: string) {
		super(reason ?? "Run stopped by runtime control");
		this.name = "ControlledStopError";
		this.reason = reason;
	}
}

export class AgentRuntimeAbortError extends Error {
	readonly reason?: unknown;

	constructor(reason?: unknown) {
		const message =
			typeof reason === "string"
				? reason
				: reason instanceof Error
					? reason.message
					: reason === undefined
						? "Run aborted"
						: String(reason);
		super(message);
		this.name = "AgentRuntimeAbortError";
		this.reason = reason;
	}
}
