import type {
	AgentModelEvent,
	AgentModelFinishReason,
	GatewayProviderContext,
	GatewayStreamRequest,
	GeneratedMedia,
	ModelToolExecution,
	ModelToolName,
	ProviderErrorClass,
} from "@plinycode/shared";
import {
	createMediaBudgetState,
	estimateContextBreakdown,
	generatedMediaModalityFromMediaType,
	validateAndReserveBase64Media,
} from "@plinycode/shared";
import { NoSuchToolError } from "ai";
import { nanoid } from "nanoid";
import {
	extractGeneratedImage,
	normalizeProjectedModelToolMedia,
	summarizeProjectedMedia,
	toGeneratedImageMedia,
} from "./ai-sdk-image-gen";
import { providerDisablesExternalToolExecution } from "./ai-sdk-message-convert";
import { applyUsageEstimateFallback, normalizeUsage } from "./ai-sdk-usage";
import {
	classifyProviderError,
	isRetryableBeyondSdkRetries,
} from "./error-classification";
import { extractErrorMessage } from "./format";
import type {
	AiSdkStreamPart,
	AiSdkStreamResult,
	BuiltModelTools,
} from "./vendors/types";

interface ActiveProjectedModelToolCall {
	toolName: ModelToolName;
	input?: unknown;
	execution: ModelToolExecution;
}

interface ProjectedModelToolResult {
	media: GeneratedMedia[];
	activityOutput: unknown;
}

function mergeToolCallMetadata(
	current: unknown,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	if (!current || typeof current !== "object" || Array.isArray(current)) {
		return patch;
	}
	return {
		...(current as Record<string, unknown>),
		...patch,
	};
}

function buildToolCallMetadata(input: {
	metadata: unknown;
	request: GatewayStreamRequest;
	context: GatewayProviderContext;
}): Record<string, unknown> {
	return mergeToolCallMetadata(input.metadata, {
		toolSource: {
			providerId: input.request.providerId,
			modelId: input.request.modelId,
			executionMode: providerDisablesExternalToolExecution(input.context)
				? "provider"
				: "runtime",
		},
	});
}

/**
 * What the model (and the log) is told about a call to a tool that does not
 * exist. Names that only differ by a leaked namespace, case or hyphens were
 * already repaired (`repairMalformedToolCall`), so reaching this means the
 * name is really unknown: say which model emitted it, point at the closest
 * real tool, and list the exact names to use.
 */
export function describeUnavailableToolCall(input: {
	toolName: string;
	availableTools: readonly string[];
	providerId: string;
	modelId: string;
}): string {
	const suggestion = suggestToolName(input.toolName, input.availableTools);
	return [
		`Tool call ${input.toolName} was rejected before execution: no tool is named "${input.toolName}" (emitted by ${input.providerId}/${input.modelId}).`,
		suggestion ? `Did you mean "${suggestion}"?` : undefined,
		"Call a tool by its exact name, without any namespace or prefix.",
		input.availableTools.length
			? `Available tools: ${input.availableTools.join(", ")}.`
			: undefined,
	]
		.filter(Boolean)
		.join(" ");
}

/** The available tool whose name is closest to a misspelled one, if any is close. */
function suggestToolName(
	toolName: string,
	availableTools: readonly string[],
): string | undefined {
	const normalize = (name: string) =>
		name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
	const requested = normalize(toolName);
	let best: { name: string; distance: number } | undefined;
	for (const name of availableTools) {
		const candidate = normalize(name);
		const distance =
			requested.endsWith(candidate) || candidate.endsWith(requested)
				? 0
				: editDistance(requested, candidate);
		if (!best || distance < best.distance) {
			best = { name, distance };
		}
	}
	return best && best.distance <= Math.max(2, Math.floor(requested.length / 4))
		? best.name
		: undefined;
}

function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(
				previous[j] + 1,
				current[j - 1] + 1,
				previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[b.length];
}

function buildRecoverableToolErrorMetadata(input: {
	part: AiSdkStreamPart;
	errorMessage: string;
	request: GatewayStreamRequest;
	context: GatewayProviderContext;
	toolName: string;
}): Record<string, unknown> {
	let inputParseError = `Tool call ${input.toolName} was rejected before execution: ${input.errorMessage}`;
	// The stream carries the error as its message string, not the instance.
	if (
		NoSuchToolError.isInstance(input.part.error) ||
		input.errorMessage.includes("AI_NoSuchToolError")
	) {
		const availableTools = (input.request.tools ?? []).map((tool) => tool.name);
		inputParseError = describeUnavailableToolCall({
			toolName: input.toolName,
			availableTools,
			providerId: input.request.providerId,
			modelId: input.request.modelId,
		});
		input.context.logger?.log("Model called an unavailable tool", {
			severity: "warn",
			providerId: input.request.providerId,
			modelId: input.request.modelId,
			toolName: input.toolName,
			availableTools,
		});
	}
	return buildToolCallMetadata({
		metadata: mergeToolCallMetadata(extractGoogleThoughtMetadata(input.part), {
			inputParseError,
			aiSdkToolError: input.errorMessage,
		}),
		request: input.request,
		context: input.context,
	});
}

function mapFinishReason(
	value: unknown,
	sawToolCalls: boolean,
): AgentModelFinishReason {
	if (value === "tool-calls" || value === "tool_calls" || sawToolCalls) {
		return "tool-calls";
	}
	if (value === "length" || value === "max_tokens") {
		return "max-tokens";
	}
	if (value === "error") {
		return "error";
	}
	return "stop";
}

function extractGoogleThoughtMetadata(
	part: AiSdkStreamPart,
): Record<string, unknown> | undefined {
	const metadata: Record<string, unknown> = {};

	if (typeof part.thoughtSignature === "string") {
		metadata.thoughtSignature = part.thoughtSignature;
	}
	if (typeof part.thought_signature === "string") {
		metadata.thought_signature = part.thought_signature;
	}

	const providerMetadata =
		part.providerMetadata && typeof part.providerMetadata === "object"
			? (part.providerMetadata as Record<string, unknown>)
			: undefined;
	const googleMetadata =
		providerMetadata?.google && typeof providerMetadata.google === "object"
			? (providerMetadata.google as Record<string, unknown>)
			: undefined;
	const vertexMetadata =
		providerMetadata?.vertex && typeof providerMetadata.vertex === "object"
			? (providerMetadata.vertex as Record<string, unknown>)
			: undefined;

	if (
		typeof metadata.thoughtSignature !== "string" &&
		typeof (
			googleMetadata?.thoughtSignature ?? vertexMetadata?.thoughtSignature
		) === "string"
	) {
		metadata.thoughtSignature =
			googleMetadata?.thoughtSignature ?? vertexMetadata?.thoughtSignature;
	}
	if (
		typeof metadata.thought_signature !== "string" &&
		typeof googleMetadata?.thought_signature === "string"
	) {
		metadata.thought_signature = googleMetadata.thought_signature;
	}

	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * A stream error captured while the raw provider error object is still in
 * hand: the flattened display message plus its classification. Both are
 * derived here because the structure needed to classify does not survive
 * `extractErrorMessage`.
 */
export interface CapturedStreamError {
	message: string;
	errorClass: ProviderErrorClass;
	/**
	 * Whether the agent loop's turn-level retry may re-run this turn, decided
	 * while the structured error is still in hand and forwarded as
	 * `errorRetryable` on the `finish` event (the flattened message the agent
	 * loop receives cannot carry it). Transient by the AI SDK's own typed
	 * `isRetryable` flag, except that a `RetryError` is terminal: the SDK
	 * already spent its request-start retries, and the turn-level retry must
	 * not multiply them.
	 */
	retryable: boolean;
}

export function captureStreamError(error: unknown): CapturedStreamError {
	return {
		message: extractErrorMessage(error),
		errorClass: classifyProviderError(error),
		retryable: isRetryableBeyondSdkRetries(error),
	};
}

export async function* emitAiSdkEvents(
	stream: AiSdkStreamResult,
	request: GatewayStreamRequest,
	context: GatewayProviderContext,
	pricingValue?: unknown,
	capturedError?: { current: CapturedStreamError | undefined },
	modelToolAdapters?: BuiltModelTools,
): AsyncIterable<AgentModelEvent> {
	let sawToolCalls = false;
	const emittedToolCallIds = new Set<string>();
	let finishReason: unknown;
	let streamError: CapturedStreamError | undefined;
	let finishUsage: unknown;
	let finishProviderMetadata: unknown;
	// Only per-step usage keeps the provider's raw wire usage; the SDK's
	// aggregated `stream.usage` / `finish.totalUsage` drop it, and with it
	// fields it does not map, such as Anthropic `cache_creation_input_tokens`.
	let finishStepRawUsage: unknown;
	let streamAborted = false;
	let sawVisibleContent = false;
	const mediaBudget = createMediaBudgetState();
	const rejectedMediaErrors: string[] = [];
	const activeProjectedModelToolCalls = new Map<
		string,
		ActiveProjectedModelToolCall
	>();
	const projectedModelToolResults = new Map<string, ProjectedModelToolResult>();
	const pendingProjectedModelToolOutputs = new Map<string, unknown>();
	const projectedModelToolErrors = new Map<string, string>();
	// Tool calls the provider executed inside this inference request (e.g. the
	// Claude Code CLI's own tools). They surface as observational activity and
	// must never enter AgentRuntime's local execution/approval loop. Result and
	// error parts are matched by ID because some providers omit the
	// providerExecuted flag on the result half of the pair.
	const observationalProviderToolCallIds = new Set<string>();

	try {
		if (stream.fullStream) {
			for await (const part of stream.fullStream) {
				if (part.type === "text-delta") {
					const text =
						(part.textDelta as string | undefined) ??
						(part.text as string | undefined) ??
						(part.delta as string | undefined);
					if (text) {
						sawVisibleContent = true;
						yield { type: "text-delta", text };
					}
					continue;
				}

				if (part.type === "reasoning-delta" || part.type === "reasoning") {
					const text =
						(part.textDelta as string | undefined) ??
						(part.text as string | undefined) ??
						(part.reasoning as string | undefined);
					if (text) {
						sawVisibleContent = true;
						yield {
							type: "reasoning-delta",
							text,
							metadata: extractGoogleThoughtMetadata(part),
						};
					}
					continue;
				}

				if (part.type === "file") {
					const extracted = extractGeneratedImage(part.file, mediaBudget);
					if (extracted.kind === "accepted") {
						sawVisibleContent = true;
						yield {
							type: "media",
							media: toGeneratedImageMedia(extracted.image),
						};
						continue;
					}
					if (extracted.kind === "rejected") {
						rejectedMediaErrors.push(extracted.error.message);
						continue;
					}
					// Preserve non-image model files on the generic event path.
					const file = part.file as
						| { base64?: string; mediaType?: string }
						| undefined;
					const data = file?.base64;
					if (typeof data === "string" && data.length > 0) {
						const mediaType = file?.mediaType ?? "application/octet-stream";
						const validation = validateAndReserveBase64Media(
							data,
							{},
							mediaBudget,
						);
						if (!validation.ok) {
							rejectedMediaErrors.push(validation.message);
							continue;
						}
						sawVisibleContent = true;
						yield {
							type: "media",
							media: {
								id: `media_${nanoid()}`,
								modality: generatedMediaModalityFromMediaType(mediaType),
								mediaType,
								source: { type: "base64", data: validation.base64 },
								sizeBytes: validation.decodedBytes,
							},
						};
					}
					continue;
				}

				if (part.type === "tool-call") {
					const toolName =
						(part.toolName as string | undefined) ??
						(part.name as string | undefined) ??
						"tool";
					// Provider-executed tools complete inside this inference request. They
					// must not enter AgentRuntime's local execution/approval loop. The same
					// applies to provider-defined client tools: streamText executes those
					// and continues the internal model step before returning control.
					const modelTool = request.modelTools?.find(
						(tool) => tool.name === toolName,
					);
					if (modelTool) {
						const explicitToolCallId =
							(part.toolCallId as string | undefined) ??
							(part.id as string | undefined);
						const adapter = modelToolAdapters?.[modelTool.name];
						if (adapter?.projectResult && !explicitToolCallId) {
							throw new Error(
								`Model tool "${modelTool.name}" call is missing a valid tool-call ID`,
							);
						}
						const toolCallId = explicitToolCallId ?? `model_tool_${nanoid()}`;
						const execution =
							part.providerExecuted === true ? "provider" : "client";
						if (adapter?.projectResult) {
							activeProjectedModelToolCalls.set(toolCallId, {
								toolName: modelTool.name,
								input: part.input ?? part.args,
								execution,
							});
						}
						yield {
							type: "tool-call-delta",
							toolCallId,
							toolName: modelTool.name,
							execution,
							input: part.input ?? part.args,
						};
						continue;
					}
					if (part.providerExecuted === true) {
						const toolCallId =
							(part.toolCallId as string | undefined) ??
							(part.id as string | undefined) ??
							`provider_tool_${nanoid()}`;
						observationalProviderToolCallIds.add(toolCallId);
						sawVisibleContent = true;
						yield {
							type: "tool-call-delta",
							toolCallId,
							toolName,
							execution: "provider",
							input: part.input ?? part.args,
						};
						continue;
					}
					sawToolCalls = true;
					sawVisibleContent = true;
					const toolCallId =
						(part.toolCallId as string | undefined) ??
						(part.id as string | undefined) ??
						`tool_${nanoid()}`;
					emittedToolCallIds.add(toolCallId);
					const input = (part.input ?? part.args ?? {}) as unknown;
					const inputText =
						typeof input === "string" ? input : JSON.stringify(input);
					yield {
						type: "tool-call-delta",
						toolCallId,
						toolName,
						input: typeof input === "string" ? undefined : input,
						inputText,
						metadata: buildToolCallMetadata({
							metadata: extractGoogleThoughtMetadata(part),
							request,
							context,
						}),
					};
					continue;
				}

				if (part.type === "tool-result") {
					const toolName =
						(part.toolName as string | undefined) ??
						(part.name as string | undefined) ??
						"tool";
					const modelTool = request.modelTools?.find(
						(tool) => tool.name === toolName,
					);
					if (modelTool) {
						const explicitToolCallId =
							(part.toolCallId as string | undefined) ??
							(part.id as string | undefined);
						const adapter = modelToolAdapters?.[modelTool.name];
						if (adapter?.projectResult && !explicitToolCallId) {
							throw new Error(
								`Model tool "${modelTool.name}" result is missing a valid tool-call ID`,
							);
						}
						const toolCallId = explicitToolCallId ?? `model_tool_${nanoid()}`;
						if (adapter?.projectResult) {
							if (part.preliminary !== true) {
								if (!activeProjectedModelToolCalls.has(toolCallId)) {
									throw new Error(
										`Model tool "${modelTool.name}" returned a result without a matching call`,
									);
								}
								// Provider SDKs can repeat a terminal tool result. Buffer the
								// latest value and validate it once so duplicates neither emit
								// duplicate media nor consume the aggregate media budget twice.
								pendingProjectedModelToolOutputs.set(
									toolCallId,
									part.output ?? part.result,
								);
								projectedModelToolErrors.delete(toolCallId);
							}
							continue;
						}
						if (part.preliminary !== true) {
							yield {
								type: "tool-result",
								toolCallId,
								toolName: modelTool.name,
								execution:
									part.providerExecuted === true ? "provider" : "client",
								input: part.input ?? part.args,
								output: part.output ?? part.result,
							};
						}
						continue;
					}
					const toolCallId =
						(part.toolCallId as string | undefined) ??
						(part.id as string | undefined);
					if (
						part.providerExecuted === true ||
						(toolCallId && observationalProviderToolCallIds.has(toolCallId))
					) {
						if (part.preliminary !== true) {
							sawVisibleContent = true;
							yield {
								type: "tool-result",
								toolCallId: toolCallId ?? `provider_tool_${nanoid()}`,
								toolName,
								execution: "provider",
								input: part.input ?? part.args,
								output: part.output ?? part.result,
							};
						}
						continue;
					}
				}

				if (part.type === "tool-error") {
					const toolName =
						(part.toolName as string | undefined) ??
						(part.name as string | undefined) ??
						"tool";
					const modelTool = request.modelTools?.find(
						(tool) => tool.name === toolName,
					);
					if (modelTool) {
						const explicitToolCallId =
							(part.toolCallId as string | undefined) ??
							(part.id as string | undefined);
						const adapter = modelToolAdapters?.[modelTool.name];
						if (adapter?.projectResult && !explicitToolCallId) {
							throw new Error(
								`Model tool "${modelTool.name}" error is missing a valid tool-call ID`,
							);
						}
						const toolCallId = explicitToolCallId ?? `model_tool_${nanoid()}`;
						if (adapter?.projectResult) {
							pendingProjectedModelToolOutputs.delete(toolCallId);
							projectedModelToolErrors.set(
								toolCallId,
								`Model tool "${modelTool.name}" failed: ${extractErrorMessage(part.error)}`,
							);
							continue;
						}
						yield {
							type: "tool-result",
							toolCallId,
							toolName: modelTool.name,
							execution: part.providerExecuted === true ? "provider" : "client",
							input: part.input ?? part.args,
							output: { error: extractErrorMessage(part.error) },
							isError: true,
						};
						continue;
					}
					{
						const errorToolCallId =
							(part.toolCallId as string | undefined) ??
							(part.id as string | undefined);
						if (
							part.providerExecuted === true ||
							(errorToolCallId &&
								observationalProviderToolCallIds.has(errorToolCallId))
						) {
							yield {
								type: "tool-result",
								toolCallId: errorToolCallId ?? `provider_tool_${nanoid()}`,
								toolName,
								execution: "provider",
								input: part.input ?? part.args,
								output: { error: extractErrorMessage(part.error) },
								isError: true,
							};
							continue;
						}
					}
					sawToolCalls = true;
					const toolCallId =
						(part.toolCallId as string | undefined) ??
						(part.id as string | undefined) ??
						`tool_${nanoid()}`;
					const alreadyEmitted = emittedToolCallIds.has(toolCallId);
					emittedToolCallIds.add(toolCallId);
					const input = (part.input ?? part.args ?? {}) as unknown;
					const inputText =
						typeof input === "string" ? input : JSON.stringify(input);
					const errorMessage =
						part.error === undefined
							? "Tool input was rejected by the model adapter"
							: extractErrorMessage(part.error);
					yield {
						type: "tool-call-delta",
						toolCallId,
						toolName,
						input: alreadyEmitted
							? undefined
							: typeof input === "string"
								? undefined
								: input,
						inputText: alreadyEmitted ? undefined : inputText,
						metadata: buildRecoverableToolErrorMetadata({
							part,
							errorMessage,
							request,
							context,
							toolName,
						}),
					};
					continue;
				}

				if (part.type === "finish-step") {
					finishStepRawUsage =
						(part.usage as { raw?: unknown } | undefined)?.raw ??
						finishStepRawUsage;
				}

				if (part.type === "finish") {
					finishUsage = part.usage ?? part.totalUsage;
					finishProviderMetadata = part.providerMetadata;
					finishReason =
						part.finishReason ?? part.rawFinishReason ?? part.reason;
				}

				if (part.type === "error") {
					streamError =
						capturedError?.current ?? captureStreamError(part.error);
					break;
				}

				if (part.type === "abort") {
					streamAborted = true;
					break;
				}
			}
		} else if (stream.textStream) {
			for await (const text of stream.textStream) {
				yield { type: "text-delta", text };
			}
		}
	} catch (error) {
		// Prefer the real provider error from onError over the generic
		// NoOutputGeneratedError the AI SDK throws when 0 steps are recorded.
		streamError = capturedError?.current ?? captureStreamError(error);
	}

	if (!streamError) {
		for (const [toolCallId, output] of pendingProjectedModelToolOutputs) {
			const active = activeProjectedModelToolCalls.get(toolCallId);
			const adapter = active ? modelToolAdapters?.[active.toolName] : undefined;
			if (!active || !adapter?.projectResult) continue;
			try {
				const projection = adapter.projectResult(output);
				const media: GeneratedMedia[] = [];
				const errors: string[] = [];
				for (const candidate of projection.media) {
					const normalized = normalizeProjectedModelToolMedia(
						candidate,
						mediaBudget,
					);
					if (normalized.ok) media.push(normalized.media);
					else errors.push(normalized.error);
				}
				if (media.length === 0) {
					projectedModelToolErrors.set(
						toolCallId,
						errors[0] ??
							`Model tool "${active.toolName}" returned no supported media`,
					);
					continue;
				}
				projectedModelToolResults.set(toolCallId, {
					media,
					activityOutput:
						projection.activityOutput ?? summarizeProjectedMedia(media),
				});
				projectedModelToolErrors.delete(toolCallId);
			} catch (error) {
				projectedModelToolErrors.set(toolCallId, extractErrorMessage(error));
			}
		}
	}

	if (!streamError && !streamAborted) {
		for (const toolCallId of activeProjectedModelToolCalls.keys()) {
			if (
				!projectedModelToolResults.has(toolCallId) &&
				!projectedModelToolErrors.has(toolCallId)
			) {
				const active = activeProjectedModelToolCalls.get(toolCallId);
				projectedModelToolErrors.set(
					toolCallId,
					`Model tool "${active?.toolName ?? "unknown"}" completed without a final result`,
				);
			}
		}
	}

	if (!streamError) {
		for (const [toolCallId, projection] of projectedModelToolResults) {
			const active = activeProjectedModelToolCalls.get(toolCallId);
			if (!active) continue;
			sawVisibleContent = true;
			for (const media of projection.media) {
				yield { type: "media", media };
			}
			yield {
				type: "tool-result",
				toolCallId,
				toolName: active.toolName,
				execution: active.execution,
				input: active.input,
				output: projection.activityOutput,
			};
		}
		for (const [toolCallId, error] of projectedModelToolErrors) {
			const active = activeProjectedModelToolCalls.get(toolCallId);
			if (!active) continue;
			yield {
				type: "tool-result",
				toolCallId,
				toolName: active.toolName,
				execution: active.execution,
				input: active.input,
				output: { error },
				isError: true,
			};
		}
		if (
			!sawVisibleContent &&
			(projectedModelToolErrors.size > 0 || rejectedMediaErrors.length > 0)
		) {
			streamError = captureStreamError(
				new Error(
					projectedModelToolErrors.values().next().value ??
						rejectedMediaErrors[0] ??
						"Model returned no supported media",
				),
			);
		}
	}

	// Prefer stream.usage (has raw cost data) over finish part usage.
	// stream.usage may be undefined in mocked/test scenarios, fall back to finish part + its providerMetadata.
	let usageToEmit: unknown;
	let metadataToUse: unknown;
	if (streamError) {
		usageToEmit = finishUsage;
		metadataToUse = finishProviderMetadata;
	} else if (stream.usage) {
		try {
			usageToEmit = await stream.usage;
		} catch (error) {
			if (!streamError) {
				streamError = capturedError?.current ?? captureStreamError(error);
			}
			usageToEmit = finishUsage;
			metadataToUse = finishProviderMetadata;
		}
	} else {
		usageToEmit = finishUsage;
		metadataToUse = finishProviderMetadata;
	}
	if (
		usageToEmit &&
		typeof usageToEmit === "object" &&
		!("raw" in usageToEmit && usageToEmit.raw) &&
		finishStepRawUsage &&
		typeof finishStepRawUsage === "object"
	) {
		usageToEmit = { ...usageToEmit, raw: finishStepRawUsage };
	}

	if (usageToEmit) {
		const normalizedUsage = normalizeUsage(
			usageToEmit,
			metadataToUse,
			pricingValue,
		);
		let outputTextForEstimate: string | undefined;
		if (
			normalizedUsage.inputTokens === 0 &&
			normalizedUsage.outputTokens === 0
		) {
			try {
				outputTextForEstimate = await stream.text;
			} catch {
				// stream.text rejects alongside the same stream errors
				// suppressDanglingStreamPromises already guards against;
				// fall back to an input-only estimate.
			}
		}
		const estimatedUsage = applyUsageEstimateFallback(
			normalizedUsage,
			request,
			outputTextForEstimate,
		);
		const contextSources = request.metadata?.contextSources as
			| { rulesText?: string; skillsText?: string; workflowsText?: string }
			| undefined;
		yield {
			type: "usage",
			usage: {
				...estimatedUsage,
				contextBreakdown: estimateContextBreakdown(
					{
						systemPrompt: request.systemPrompt,
						rulesText: contextSources?.rulesText,
						skillsText: contextSources?.skillsText,
						workflowsText: contextSources?.workflowsText,
						messages: request.messages,
					},
					estimatedUsage.inputTokens > 0
						? estimatedUsage.inputTokens
						: undefined,
				),
			},
		};
	}

	yield {
		type: "finish",
		reason: streamError ? "error" : mapFinishReason(finishReason, sawToolCalls),
		error: streamError?.message,
		errorClass: streamError?.errorClass,
		errorRetryable: streamError?.retryable,
	};
}
