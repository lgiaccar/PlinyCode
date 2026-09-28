import type { LanguageModelV4 } from "@ai-sdk/provider";
import type {
	GatewayProviderContext,
	GatewayProviderFactory,
	GatewayResolvedProviderConfig,
} from "@plinycode/shared";
import {
	createMediaBudgetState,
	modelSupportsToolCalling,
	usesImageGenerationOperation,
} from "@plinycode/shared";
import { generateImage, stepCountIs, streamText, wrapLanguageModel } from "ai";
import {
	extractGeneratedImage,
	resolveImageGenerationPrompt,
	toGeneratedImageMedia,
} from "./ai-sdk-image-gen";
import {
	buildAiSdkRequestMessages,
	buildAiSdkRuntimeContext,
	buildAiSdkStreamConfig,
	buildProviderModelTools,
	hasAiSdkTool,
	mergeAiSdkTools,
	providerDisablesExternalToolExecution,
	repairMalformedToolCall,
	toAiSdkModelToolSet,
	toAiSdkTools,
} from "./ai-sdk-message-convert";
import { wrapFetchForStickySession } from "./ai-sdk-sticky-session";
import {
	type CapturedStreamError,
	captureStreamError,
	emitAiSdkEvents,
} from "./ai-sdk-stream-events";
import { normalizeUsage } from "./ai-sdk-usage";
import { createRetryEmptyResponseMiddleware } from "./middleware/retry-empty-response";
import {
	recordProviderRequestCapture,
	wrapFetchForProviderRequestCapture,
} from "./provider-request-capture";
import { resolvePortableReasoning } from "./routing/portable-reasoning";
import { composeAiSdkProviderOptions } from "./routing/provider-options";
import type { AiSdkStreamResult, ProviderFactoryResult } from "./vendors/types";

type ProviderModuleKind = "openai-compatible" | "anthropic";

/**
 * AI SDK request-level retries for each model call (the SDK default is 2). The
 * SDK retries the *initial* request on transient failures — 429/5xx/network —
 * with exponential backoff that honors `retry-after` headers. It never sees an
 * error the provider emits *mid-stream* (OpenRouter's "Provider returned error"
 * arrives as a stream part after a 200), so the agent loop keeps its own
 * turn-level retry for those.
 *
 * Each failure class has exactly one retrying layer, so the counts never
 * multiply: request-start failures belong to this setting (a `RetryError` is
 * terminal for the turn-level retry, see `isRetryableBeyondSdkRetries`);
 * pre-output socket deaths and empty responses belong to
 * `withEmptyResponseRetry`, which never sees request-start rejections; and
 * mid-stream provider errors belong to the turn-level retry alone.
 */
const MODEL_REQUEST_MAX_RETRIES = 5;

/**
 * Suppress unhandled rejections from AI SDK stream promises (usage, finishReason, etc.)
 * that reject with NoOutputGeneratedError when the stream encounters an error.
 *
 * The AI SDK's streamText result exposes lazy promise getters (finishReason, totalUsage,
 * steps, text, usage, etc.) backed by internal DelayedPromise instances. When the stream
 * errors with 0 recorded steps, the flush callback rejects all of them. We must access
 * each getter to obtain the promise and attach a no-op rejection handler before Bun/Node
 * surfaces them as unhandled rejections.
 */
function suppressDanglingStreamPromises(
	stream: AiSdkStreamResult | undefined,
): void {
	if (!stream) return;
	const noop = () => {};
	const suppress = (val: unknown) => {
		if (val && typeof (val as Promise<unknown>).catch === "function") {
			(val as Promise<unknown>).catch(noop);
		}
	};

	// Access known lazy promise getters on the AI SDK StreamTextResult object.
	const s = stream as Record<string, unknown>;

	// Catch-all for any remaining promise-valued own properties.
	for (const key of Object.keys(stream)) {
		try {
			suppress(s[key]);
		} catch {
			// ignore
		}
	}
}

async function createProviderModule(
	kind: ProviderModuleKind,
	config: GatewayResolvedProviderConfig,
	context: GatewayProviderContext,
): Promise<ProviderFactoryResult> {
	switch (kind) {
		case "openai-compatible": {
			const { createOpenAICompatibleProviderModule } = await import(
				"./vendors/openai-compatible"
			);
			return createOpenAICompatibleProviderModule(config, context);
		}
		case "anthropic": {
			const { createAnthropicProviderModule } = await import(
				"./vendors/anthropic"
			);
			return createAnthropicProviderModule(config, context);
		}
	}
}

/**
 * Wrap a vendor-constructed model with the transient-failure retry
 * middleware (empty responses + pre-content network interruptions).
 *
 * All-empty turns (no text, no reasoning, no tool call) are a cross-provider
 * phenomenon: production telemetry shows them on hosted backends (openrouter,
 * cline, generic OpenAI-compatible endpoints), not just local Ollama. An
 * empty assistant turn is a hard failure in the agent runtime ("Model
 * returned empty response"), so a single transient flake kills the task.
 * The same telemetry shows mid-stream network deaths (UND_ERR_SOCKET,
 * body/headers timeouts, ECONNRESET) as the dominant network-class run
 * killer — the AI SDK's own retry covers only request initiation, so once a
 * stream has started nothing else retries. Retrying here — the one
 * composition point every AI SDK vendor flows through — turns those flakes
 * into non-events while leaving the runtime's loud failure in place for
 * models that are persistently empty or connections that are truly down.
 *
 * Applied as the *outermost* wrap so each retry re-runs the vendor's full
 * request pipeline, including any vendor-level middleware attached inside
 * `provider.operations.language(...)`. Vendors opt out or tune attempts through
 * `ProviderFactoryResult.retryEmptyResponses`.
 */
export function withEmptyResponseRetry(
	model: unknown,
	retryEmptyResponses: ProviderFactoryResult["retryEmptyResponses"],
	logger: GatewayProviderContext["logger"],
): unknown {
	if (retryEmptyResponses === false) {
		return model;
	}
	return wrapLanguageModel({
		model: model as LanguageModelV4,
		middleware: createRetryEmptyResponseMiddleware({
			...retryEmptyResponses,
			logger,
		}),
	});
}

function createAiSdkProvider(
	defaultKind: ProviderModuleKind,
): GatewayProviderFactory {
	return async (config) => ({
		async *stream(request, context) {
			const kind = defaultKind;
			const log = context.logger;
			let stream: AiSdkStreamResult | undefined;
			const capturedError: { current: CapturedStreamError | undefined } = {
				current: undefined,
			};
			try {
				const provider = await createProviderModule(
					kind,
					{
						...config,
						fetch: wrapFetchForStickySession(
							wrapFetchForProviderRequestCapture(config.fetch, request),
							request,
							context,
						),
					},
					context,
				);
				const providerOptions = composeAiSdkProviderOptions(
					request,
					context,
					kind,
				);
				const modelOperation = context.model.operation ?? "language";
				if (
					modelOperation !== "language" &&
					modelOperation !== "image-generation"
				) {
					throw new Error(
						`Provider "${context.provider.id}" does not implement the "${modelOperation}" model operation`,
					);
				}
				if (usesImageGenerationOperation(context.model)) {
					if (!provider.operations.imageGeneration) {
						throw new Error(
							`Provider "${context.provider.id}" does not support image generation models`,
						);
					}
					const prompt = resolveImageGenerationPrompt(request, context);
					recordProviderRequestCapture({
						stage: "ai_sdk_prompt",
						request,
						payload: {
							operation: "generate_image",
							prompt:
								typeof prompt === "string"
									? prompt
									: {
											text: prompt.text,
											imageCount: prompt.images.length,
										},
							providerOptions,
						},
					});
					const result = await generateImage({
						model: provider.operations.imageGeneration(
							context.model.id,
						) as never,
						prompt,
						abortSignal: request.signal,
						providerOptions: providerOptions as never,
					});
					let emittedImages = 0;
					let rejectedImageError: string | undefined;
					const mediaBudget = createMediaBudgetState();
					for (const file of result.images) {
						const extracted = extractGeneratedImage(file, mediaBudget);
						if (extracted.kind === "rejected") {
							rejectedImageError = extracted.error.message;
							continue;
						}
						if (extracted.kind !== "accepted") continue;
						emittedImages += 1;
						yield {
							type: "media",
							media: toGeneratedImageMedia(extracted.image),
						};
					}
					if (emittedImages === 0) {
						throw new Error(
							rejectedImageError ?? "Image model returned no supported images",
						);
					}
					if (result.usage) {
						yield {
							type: "usage",
							usage: normalizeUsage(
								result.usage as Record<string, unknown>,
								result.providerMetadata,
								context.model.metadata?.pricing,
							),
						};
					}
					yield { type: "finish", reason: "stop" };
					return;
				}
				const externalToolExecutionDisabled =
					providerDisablesExternalToolExecution(context);
				const toolCallingDisabled =
					externalToolExecutionDisabled ||
					!modelSupportsToolCalling(context.model);
				const runtimeTools = toolCallingDisabled
					? undefined
					: toAiSdkTools(request);
				const activeModelTools = toolCallingDisabled
					? []
					: (request.modelTools ?? []).filter(
							(tool) => !hasAiSdkTool(runtimeTools, tool.name),
						);
				const modelToolRequest = {
					...request,
					modelTools: activeModelTools,
				};
				const modelToolAdapters = buildProviderModelTools(
					provider,
					modelToolRequest,
					context,
				);
				const modelTools = toAiSdkModelToolSet(modelToolAdapters);
				const tools = mergeAiSdkTools(runtimeTools, modelTools);
				const systemPrompt = request.systemPrompt;
				const useSystemOption =
					typeof systemPrompt === "string" && systemPrompt.trim().length > 0;
				const messagesSystemPrompt = useSystemOption ? undefined : systemPrompt;
				const messages = buildAiSdkRequestMessages(
					request,
					context,
					messagesSystemPrompt,
				);
				const portableReasoning = resolvePortableReasoning(request);
				const requestConfig = provider.buildStreamConfig
					? provider.buildStreamConfig(request, context)
					: buildAiSdkStreamConfig(request, context);
				recordProviderRequestCapture({
					stage: "ai_sdk_prompt",
					request,
					payload: {
						messages,
						...(useSystemOption ? { system: systemPrompt } : {}),
						tools,
						providerOptions,
						...requestConfig,
						...(portableReasoning ? { reasoning: portableReasoning } : {}),
					},
				});
				stream = streamText({
					model: withEmptyResponseRetry(
						provider.operations.language(context.model.id),
						provider.retryEmptyResponses,
						context.logger,
					) as never,
					messages: messages as never,
					...(useSystemOption ? { system: systemPrompt } : {}),
					...(tools ? { tools } : {}),
					abortSignal: request.signal,
					maxRetries: MODEL_REQUEST_MAX_RETRIES,
					experimental_repairToolCall: repairMalformedToolCall as never,
					runtimeContext: buildAiSdkRuntimeContext(request, context),
					providerOptions: providerOptions as never,
					...(provider.executesModelTools && activeModelTools.length
						? { stopWhen: stepCountIs(8) }
						: {}),
					...requestConfig,
					...(portableReasoning ? { reasoning: portableReasoning } : {}),
					onError: ({ error: streamError }) => {
						const captured = captureStreamError(streamError);
						const msg = captured.message;
						capturedError.current = captured;
						if (log?.error) {
							log.error("[ai-sdk] stream error", {
								providerId: request.providerId,
								error: streamError,
								severity: "error",
							});
						} else if (log) {
							log.log(`[ai-sdk] stream error: ${msg}`, {
								providerId: request.providerId,
								severity: "error",
							});
						}
					},
				}) as unknown as AiSdkStreamResult;

				// Suppress dangling promise rejections (finishReason, totalUsage, steps, etc.)
				// BEFORE iterating. The AI SDK rejects these DelayedPromises inside the stream's
				// flush callback, which runs during iteration, so we must attach .catch() handlers
				// upfront or Bun/Node will surface them as unhandled rejections.
				suppressDanglingStreamPromises(stream);

				yield* emitAiSdkEvents(
					stream,
					modelToolRequest,
					context,
					context.model.metadata?.pricing,
					capturedError,
					modelToolAdapters,
				);
			} catch (error) {
				suppressDanglingStreamPromises(stream);
				// Prefer the real provider error captured in onError over the generic
				// NoOutputGeneratedError that the AI SDK throws when 0 steps are recorded.
				const captured = capturedError.current ?? captureStreamError(error);
				const msg = captured.message;
				if (log?.error) {
					log.error("[ai-sdk] provider error", {
						providerId: request.providerId,
						error,
						severity: "error",
					});
				} else if (log) {
					log.log(`[ai-sdk] provider error: ${msg}`, {
						providerId: request.providerId,
						severity: "error",
					});
				}
				yield {
					type: "finish",
					reason: "error",
					error: msg,
					errorClass: captured.errorClass,
					errorRetryable: captured.retryable,
				};
			}
		},
	});
}

export const createOpenAICompatibleProvider =
	createAiSdkProvider("openai-compatible");
export const createAnthropicProvider = createAiSdkProvider("anthropic");
