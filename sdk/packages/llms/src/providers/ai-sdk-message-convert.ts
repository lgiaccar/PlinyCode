import type {
	AgentMessage,
	GatewayProviderContext,
	GatewayStreamRequest,
} from "@plinycode/shared";
import {
	type AiSdkFormatterMessage,
	type AiSdkFormatterPart,
	formatMessagesForAiSdk,
	parseJsonStream,
	sanitizeSurrogates,
} from "@plinycode/shared";
import {
	type CallSettings,
	jsonSchema,
	NoSuchToolError,
	type ToolSet,
} from "ai";
import {
	parseGluedToolCall,
	resolveMisnamedTool,
	withKimiToolCallIds,
} from "./kimi-tool-calls";
import {
	isAnthropicCompatibleModel,
	isCerebrasProvider,
	isKimiModel,
	modelSupportsImageInput,
	resolveModelFamily,
} from "./model-facts";
import {
	applyPromptCacheToLastTextPart,
	shouldApplyPromptCache,
} from "./routing/anthropic-compatible";
import {
	applyBedrockCachePointToLastUserMessage,
	shouldApplyBedrockCachePoint,
} from "./routing/bedrock-cache-point";
import { resolvePortableReasoning } from "./routing/portable-reasoning";
import type { BuiltModelTools, ProviderFactoryResult } from "./vendors/types";

export function buildAiSdkStreamConfig(
	request: GatewayStreamRequest,
	_context: GatewayProviderContext,
): Partial<CallSettings> {
	const reasoning = resolvePortableReasoning(request);
	return {
		...(request.maxTokens !== undefined
			? { maxOutputTokens: request.maxTokens }
			: {}),
		temperature: request.temperature,
		...(reasoning ? { reasoning } : {}),
	};
}

export function buildProviderModelTools(
	provider: ProviderFactoryResult,
	request: GatewayStreamRequest,
	context: GatewayProviderContext,
): BuiltModelTools | undefined {
	if (!request.modelTools?.length) {
		return undefined;
	}

	const requestedNames = [
		...new Set(request.modelTools.map((tool) => tool.name)),
	];
	if (!provider.buildModelTools) {
		throw new Error(
			`Provider adapter for "${context.provider.id}" does not implement requested model tool(s): ${requestedNames.join(", ")}.`,
		);
	}

	const modelTools = provider.buildModelTools(request.modelTools);
	const missingNames = requestedNames.filter(
		(toolName) => !Object.hasOwn(modelTools, toolName),
	);
	if (missingNames.length > 0) {
		throw new Error(
			`Provider adapter for "${context.provider.id}" did not build requested model tool(s): ${missingNames.join(", ")}.`,
		);
	}

	return modelTools;
}

export function toAiSdkModelToolSet(
	modelTools: BuiltModelTools | undefined,
): ToolSet | undefined {
	if (!modelTools) return undefined;
	const entries = Object.entries(modelTools).flatMap(([name, adapter]) =>
		adapter ? [[name, adapter.tool] as const] : [],
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function buildAiSdkRequestMessages(
	request: GatewayStreamRequest,
	context: GatewayProviderContext,
	systemPrompt?: string,
) {
	// Kimi is shown its earlier calls by id and imitates what it sees, so the
	// ids in its history must be the ones it writes itself.
	const messages = isKimiModel(request, context)
		? withKimiToolCallIds(
				request.messages,
				(request.tools ?? []).map((tool) => tool.name),
			)
		: request.messages;
	const aiMessages = toAiSdkMessages(messages, systemPrompt, {
		includeReasoning: shouldIncludeReasoningHistory(request, context),
		supportedInputModalities:
			context.model.modalities?.input ??
			(context.model.capabilities
				? modelSupportsImageInput(context)
					? ["text", "image"]
					: ["text"]
				: undefined),
	}) as Array<Record<string, unknown>>;

	if (shouldApplyBedrockCachePoint(request, context)) {
		applyBedrockCachePointToLastUserMessage(aiMessages);
		return aiMessages;
	}

	if (!shouldApplyPromptCache(request, context)) {
		return aiMessages;
	}

	const includeAnthropic = isAnthropicCompatibleModel({
		modelId: request.modelId,
		family: resolveModelFamily(context),
	});

	for (let i = aiMessages.length - 1; i >= 0; i--) {
		if (aiMessages[i]?.role === "user") {
			applyPromptCacheToLastTextPart(
				aiMessages[i],
				request.providerId,
				includeAnthropic,
			);
			break;
		}
	}

	return aiMessages;
}

function shouldIncludeReasoningHistory(
	request: GatewayStreamRequest,
	context: GatewayProviderContext,
): boolean {
	return !isCerebrasProvider(request, context);
}

export function buildAiSdkRuntimeContext(
	request: GatewayStreamRequest,
	context: GatewayProviderContext,
): Record<string, unknown> {
	const requestMetadata = request.metadata;
	const metadata =
		requestMetadata && typeof requestMetadata === "object"
			? requestMetadata
			: {};
	const tags = Array.isArray(metadata.tags)
		? metadata.tags.filter(
				(value): value is string =>
					typeof value === "string" && value.trim().length > 0,
			)
		: undefined;
	const distinctId =
		typeof metadata.distinctId === "string" ? metadata.distinctId : undefined;

	return {
		// `distinctId` is Cline's canonical identity field; `userId` is the
		// same value under the name other integrations use.
		...(distinctId ? { distinctId, userId: distinctId } : {}),
		...(typeof metadata.sessionId === "string"
			? { sessionId: metadata.sessionId }
			: {}),
		...(typeof metadata.clientName === "string"
			? { clientName: metadata.clientName }
			: {}),
		...(typeof metadata.clientVersion === "string"
			? { clientVersion: metadata.clientVersion }
			: {}),
		...(typeof metadata.clineCoreVersion === "string"
			? { clineCoreVersion: metadata.clineCoreVersion }
			: {}),
		...(tags && tags.length > 0 ? { tags } : {}),
		// Cline correlation fields.
		...(typeof metadata.conversationId === "string"
			? { conversationId: metadata.conversationId }
			: {}),
		...(typeof metadata.runId === "string" ? { runId: metadata.runId } : {}),
		...(typeof metadata.iteration === "number"
			? { iteration: metadata.iteration }
			: {}),
		providerId: request.providerId,
		modelId: request.modelId,
		resolvedModelId: context.model.id,
	};
}

function toAiSdkMessages(
	messages: readonly AgentMessage[],
	systemPrompt?: string,
	options?: {
		includeReasoning?: boolean;
		supportedInputModalities?: readonly string[];
	},
) {
	const includeReasoning = options?.includeReasoning ?? true;
	const normalizedMessages: AiSdkFormatterMessage[] = [];

	for (const message of messages) {
		const content: AiSdkFormatterPart[] = [];
		let skippedReasoning = false;
		for (const part of message.content) {
			if (part.type === "text") {
				content.push({ type: "text", text: sanitizeSurrogates(part.text) });
				continue;
			}

			if (part.type === "reasoning") {
				if (!includeReasoning) {
					skippedReasoning = true;
					continue;
				}
				const metadata = part.metadata as Record<string, unknown> | undefined;
				const signature = metadata?.signature;
				const redactedData = metadata?.redactedData;
				content.push({
					type: "reasoning",
					text: sanitizeSurrogates(part.text),
					...(typeof signature === "string" || typeof redactedData === "string"
						? {
								providerOptions: {
									anthropic: {
										...(typeof signature === "string" ? { signature } : {}),
										...(typeof redactedData === "string"
											? { redactedData }
											: {}),
									},
								},
							}
						: {}),
				});
				continue;
			}

			if (part.type === "file") {
				content.push({
					type: "file",
					path: part.path,
					content: part.content,
				});
				continue;
			}

			if (part.type === "image") {
				content.push({
					type: "image",
					image: part.image,
					mediaType: part.mediaType,
				});
				continue;
			}

			if (part.type === "media") {
				content.push({ type: "media", media: part.media });
				continue;
			}

			if (part.type === "tool-call") {
				const metadata = part.metadata as Record<string, unknown> | undefined;
				const thoughtSignature =
					metadata?.thoughtSignature ??
					metadata?.signature ??
					metadata?.thought_signature;
				content.push({
					type: "tool-call",
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					input: part.input,
					...(typeof thoughtSignature === "string"
						? {
								providerOptions: {
									google: { thoughtSignature },
								},
							}
						: {}),
				});
				continue;
			}

			if (part.type === "tool-result") {
				content.push({
					type: "tool-result",
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					output: part.output,
					isError: part.isError ?? false,
				});
			}
		}

		// A message left empty only because its reasoning was dropped is
		// omitted entirely instead of forwarded as an empty turn.
		const emptiedByDroppedReasoning = !includeReasoning && skippedReasoning;
		if (content.length > 0) {
			normalizedMessages.push({ role: message.role, content });
		} else if (
			!emptiedByDroppedReasoning &&
			(message.role === "user" || message.role === "assistant")
		) {
			normalizedMessages.push({ role: message.role, content: "" });
		}
	}

	return formatMessagesForAiSdk(systemPrompt, normalizedMessages, {
		assistantToolCallArgKey: "input",
		supportedInputModalities: options?.supportedInputModalities,
	});
}

export function toAiSdkTools(
	request: GatewayStreamRequest,
): ToolSet | undefined {
	if (!request.tools?.length) {
		return undefined;
	}

	// No validate callback on purpose: schema validation belongs to the tools
	// themselves (core executors validate with lenient union schemas that
	// accept common weak-model shapes like a bare string for a string[]
	// property). Rejecting here would return an error to the model without
	// the tool's own input handling ever seeing the call.
	const tools: ToolSet = {};
	for (const definition of request.tools) {
		tools[definition.name] = {
			description: definition.description,
			inputSchema: jsonSchema(
				normalizeAiSdkToolInputSchema(definition.inputSchema),
			),
		};
	}
	return tools;
}

export function mergeAiSdkTools(
	runtimeTools: ToolSet | undefined,
	providerTools: ToolSet | undefined,
): ToolSet | undefined {
	// Runtime tools carry the caller's executor contract, so they retain
	// ownership when a provider happens to register the same public name.
	const tools = {
		...(providerTools ?? {}),
		...(runtimeTools ?? {}),
	};
	return Object.keys(tools).length > 0 ? tools : undefined;
}

export function hasAiSdkTool(
	tools: ToolSet | undefined,
	toolName: string,
): boolean {
	return tools !== undefined && Object.hasOwn(tools, toolName);
}

interface RepairableToolCall {
	toolCallId: string;
	toolName: string;
	input: string;
}

/**
 * Last-chance repair for tool calls the AI SDK could not accept.
 *
 * - An unavailable tool name is mapped onto the tool the model meant when the
 *   name only differs by a leaked namespace, case, hyphens or a call index
 *   (`resolveMisnamedTool`).
 * - A whole call glued into the name — Kimi's call id, its JSON arguments and
 *   its control tokens, with the arguments themselves empty — is taken apart
 *   again (`parseGluedToolCall`). Anything else stays an unavailable-tool
 *   error.
 * - Arguments that are not valid JSON (truncated payloads, single quotes,
 *   unescaped newlines — common with weaker models) are run through the
 *   shared jsonrepair strategies. Already-valid JSON is a schema mismatch,
 *   which the tool's own lenient schemas handle, so it is left alone.
 *
 * Returning null preserves the AI SDK's original error behavior.
 */
export async function repairMalformedToolCall<T extends RepairableToolCall>({
	toolCall,
	tools,
	error,
}: {
	toolCall: T;
	tools?: Record<string, unknown>;
	error: unknown;
}): Promise<T | null> {
	if (NoSuchToolError.isInstance(error)) {
		const available =
			(error as { availableTools?: readonly string[] }).availableTools ??
			Object.keys(tools ?? {});
		const toolName = resolveMisnamedTool(toolCall.toolName, available);
		if (toolName) {
			return { ...toolCall, toolName };
		}
		const glued = parseGluedToolCall(toolCall.toolName, available);
		if (!glued) {
			return null;
		}
		// The arguments travelled in the name; the call's own are empty.
		return {
			...toolCall,
			toolName: glued.toolName,
			...(glued.input && hasNoArguments(toolCall.input)
				? { input: glued.input }
				: {}),
		};
	}
	if (typeof toolCall.input !== "string" || toolCall.input.trim() === "") {
		return null;
	}
	try {
		JSON.parse(toolCall.input);
		// Valid JSON means the failure was a schema mismatch, not a parse
		// error. That is left to the tool executor's own lenient union
		// schemas; there is nothing to repair here.
		return null;
	} catch {
		// Not valid JSON — attempt repair below.
	}
	const repaired = parseJsonStream(toolCall.input);
	if (repaired === toolCall.input || typeof repaired === "string") {
		return null;
	}
	return { ...toolCall, input: JSON.stringify(repaired) };
}

/** True for a call whose arguments are missing, blank or `{}`. */
function hasNoArguments(input: unknown): boolean {
	if (typeof input !== "string" || input.trim() === "") {
		return true;
	}
	try {
		const parsed = JSON.parse(input);
		return (
			parsed === null ||
			(typeof parsed === "object" && Object.keys(parsed).length === 0)
		);
	} catch {
		return false;
	}
}

function normalizeAiSdkToolInputSchema(
	inputSchema: Record<string, unknown>,
): Record<string, unknown> {
	if (inputSchema.type === "object") {
		return inputSchema;
	}

	return {
		type: "object",
		...inputSchema,
	};
}

export function providerDisablesExternalToolExecution(
	context: GatewayProviderContext,
): boolean {
	return context.provider.capabilities?.includes("provider-tools") ?? false;
}
