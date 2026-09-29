import {
	classifyProviderError,
	isRetryableProviderError,
} from "@plinycode/llms";
import type {
	AgentBeforeModelResult,
	AgentMessage,
	AgentMessagePart,
	AgentModelEvent,
	AgentModelFinishReason,
	AgentModelRequest,
	AgentModelToolActivity,
	AgentStopControl,
	AgentToolCallPart,
	AgentToolDefinition,
	AgentUsage,
} from "@plinycode/shared";
import {
	mergeModelOptions,
	omitUndefinedValues,
	trimNonEmpty,
} from "@plinycode/shared";
import {
	CONTEXT_WINDOW_OVERFLOW_NOTHING_TO_COMPACT_MESSAGE,
	ContextWindowOverflowError,
} from "./agent-errors";
import type { AgentLoopContext } from "./agent-loop-context";
import {
	cloneMessages,
	cloneUsage,
	createMessage,
	createUID,
	summarizeModelRequest,
	usageDelta,
} from "./agent-messages";
import {
	buildInvalidToolInput,
	type InvalidToolCall,
	mergeToolInputText,
	mergeToolMetadata,
	type PendingToolAssembly,
	parseToolInput,
} from "./tool-input-parse";

export async function generateAssistantMessage(
	ctx: AgentLoopContext,
	options?: {
		overflowRecovery?: boolean;
	},
): Promise<{
	message: AgentMessage;
	finishReason: AgentModelFinishReason;
	interrupted?: boolean;
}> {
	const controller = new AbortController();
	ctx.modelSteerController = controller;
	try {
		return await generateAssistantMessageForRequest(ctx, controller, options);
	} finally {
		ctx.modelSteerController = undefined;
	}
}

async function generateAssistantMessageForRequest(
	ctx: AgentLoopContext,
	steerController: AbortController,
	options?: {
		overflowRecovery?: boolean;
	},
): Promise<{
	message: AgentMessage;
	finishReason: AgentModelFinishReason;
	interrupted?: boolean;
}> {
	const usageBeforeModel = cloneUsage(ctx.state.usage);
	const modelRequestMetadata = omitUndefinedValues({
		distinctId: trimNonEmpty(ctx.config.distinctId),
		clientName: trimNonEmpty(ctx.config.clientName),
		clientVersion: trimNonEmpty(ctx.config.clientVersion),
		clineCoreVersion: trimNonEmpty(ctx.config.clineCoreVersion),
		sessionId: trimNonEmpty(ctx.config.sessionId),
		agentId: ctx.state.agentId,
		conversationId: trimNonEmpty(ctx.config.conversationId),
		runId: ctx.state.runId,
		iteration: ctx.state.iteration,
	});
	let request: AgentModelRequest = {
		systemPrompt: ctx.config.systemPrompt,
		messages: cloneMessages(ctx.state.messages),
		tools: [...ctx.tools.values()].map<AgentToolDefinition>((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
		})),
		modelTools: ctx.config.modelTools,
		signal: ctx.abortController?.signal,
		options: mergeModelOptions(ctx.config.modelOptions, {
			metadata: modelRequestMetadata,
		}),
	};

	if (ctx.state.iteration > 1) {
		// Messages that arrive from here on belong to the next step's tools.
		ctx.userMessageController = new AbortController();
		const pendingUserMessage = await consumePendingUserMessage(ctx);
		if (pendingUserMessage) {
			request = {
				...request,
				messages: [...request.messages, ...cloneMessages([pendingUserMessage])],
			};
		}
		const systemNotice = await consumeSystemNotice(ctx);
		if (systemNotice) {
			request = {
				...request,
				messages: [...request.messages, ...cloneMessages([systemNotice])],
			};
		}
	}

	request = await prepareTurnForModelRequest(ctx, request, options);
	ctx.throwIfAborted();

	for (const hook of ctx.hooks.beforeModel) {
		const result = (await hook({
			snapshot: ctx.snapshot(),
			request,
		})) as AgentBeforeModelResult | undefined;
		ctx.throwIfAborted();
		ctx.applyStopControl(result);
		if (result?.messages) {
			request = { ...request, messages: cloneMessages(result.messages) };
		}
		if (result?.tools) {
			request = { ...request, tools: [...result.tools] };
		}
		if (result?.options) {
			request = {
				...request,
				options: mergeModelOptions(request.options, result.options),
			};
		}
	}

	ctx.config.logger?.debug("Agent model request diagnostics", {
		iteration: ctx.state.iteration,
		providerId:
			"providerId" in ctx.config && typeof ctx.config.providerId === "string"
				? ctx.config.providerId
				: undefined,
		modelId:
			"modelId" in ctx.config && typeof ctx.config.modelId === "string"
				? ctx.config.modelId
				: undefined,
		...summarizeModelRequest(request),
	});

	ctx.throwIfAborted();
	// Steering cancels provider generation, while request preparation keeps
	// the run-level signal so compaction and hooks can finish consistently.
	request = {
		...request,
		signal: AbortSignal.any([
			steerController.signal,
			...(ctx.abortController ? [ctx.abortController.signal] : []),
		]),
	};
	const stream = openModelStream(ctx, request);

	const content: AgentMessagePart[] = [];
	const toolAssemblies = new Map<string, PendingToolAssembly>();
	const modelToolActivities = new Map<string, AgentModelToolActivity>();
	const invalidToolCalls: InvalidToolCall[] = [];
	const sequence: Array<
		{ type: "tool"; key: string } | { type: "part"; part: AgentMessagePart }
	> = [];
	let nextToolIndex = 0;
	let finishReason: AgentModelFinishReason = "stop";
	let accumulatedText = "";
	let accumulatedReasoning = "";

	for await (const event of stream) {
		if (steerController.signal.aborted) break;
		ctx.throwIfAborted();
		switch (event.type) {
			case "text-delta": {
				accumulatedText += event.text;
				const last = sequence.at(-1);
				if (last?.type === "part" && last.part.type === "text") {
					last.part.text += event.text;
				} else {
					sequence.push({
						type: "part",
						part: { type: "text", text: event.text },
					});
				}
				await ctx.emit({
					type: "assistant-text-delta",
					snapshot: ctx.snapshot(),
					iteration: ctx.state.iteration,
					text: event.text,
					accumulatedText,
				});
				break;
			}
			case "media": {
				sequence.push({
					type: "part",
					part: {
						type: "media",
						media: event.media,
					},
				});
				await ctx.emit({
					type: "assistant-media",
					snapshot: ctx.snapshot(),
					iteration: ctx.state.iteration,
					media: event.media,
				});
				break;
			}
			case "reasoning-delta": {
				accumulatedReasoning += event.text;
				const last = sequence.at(-1);
				if (last?.type === "part" && last.part.type === "reasoning") {
					last.part.text += event.text;
					last.part.redacted = event.redacted ?? last.part.redacted;
					last.part.metadata = event.metadata ?? last.part.metadata;
				} else {
					sequence.push({
						type: "part",
						part: {
							type: "reasoning",
							text: event.text,
							redacted: event.redacted,
							metadata: event.metadata,
						},
					});
				}
				await ctx.emit({
					type: "assistant-reasoning-delta",
					snapshot: ctx.snapshot(),
					iteration: ctx.state.iteration,
					text: event.text,
					accumulatedText: accumulatedReasoning,
					redacted: event.redacted,
					metadata: event.metadata,
				});
				break;
			}
			case "tool-call-delta": {
				if (event.execution) {
					const toolCall: AgentToolCallPart = {
						type: "tool-call",
						toolCallId: event.toolCallId ?? createUID("model_tool"),
						toolName: event.toolName ?? "tool",
						input: event.input,
						metadata: event.metadata,
						execution: event.execution,
					};
					modelToolActivities.set(toolCall.toolCallId, {
						toolCallId: toolCall.toolCallId,
						toolName: toolCall.toolName,
						execution: event.execution,
						input: toolCall.input,
					});
					await ctx.emit({
						type: "tool-started",
						snapshot: ctx.snapshot(),
						iteration: ctx.state.iteration,
						toolCall,
					});
					break;
				}
				const key = event.toolCallId ?? `tool_${event.index ?? nextToolIndex}`;
				if (event.index == null && event.toolCallId == null) {
					nextToolIndex += 1;
				}
				let assembly = toolAssemblies.get(key);
				if (!assembly) {
					assembly = {
						toolCallId: event.toolCallId ?? createUID("tool"),
						inputText: "",
					};
					toolAssemblies.set(key, assembly);
					sequence.push({ type: "tool", key });
				}
				if (event.toolCallId) {
					assembly.toolCallId = event.toolCallId;
				}
				if (event.toolName) {
					assembly.toolName = event.toolName;
				}
				if (event.input !== undefined) {
					assembly.inputValue = event.input;
				}
				if (event.metadata !== undefined) {
					assembly.metadata = mergeToolMetadata(
						assembly.metadata,
						event.metadata,
					);
				}
				if (event.inputText) {
					assembly.inputText = mergeToolInputText(
						assembly.inputText,
						event.inputText,
					);
				}
				break;
			}
			case "tool-result": {
				const existing = modelToolActivities.get(event.toolCallId);
				const activity = {
					...existing,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					execution: event.execution,
					input: event.input === undefined ? existing?.input : event.input,
					output: event.output,
					isError: event.isError,
				};
				modelToolActivities.set(event.toolCallId, activity);
				const toolCall: AgentToolCallPart = {
					type: "tool-call",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					input: activity.input,
					execution: event.execution,
				};
				await ctx.emit({
					type: "tool-finished",
					snapshot: ctx.snapshot(),
					iteration: ctx.state.iteration,
					toolCall,
					message: createMessage("tool", [
						{
							type: "tool-result",
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							output: event.output,
							isError: event.isError,
							execution: event.execution,
						},
					]),
				});
				break;
			}
			case "usage": {
				// Record the provider's own input-token count for this request so
				// the prepare-turn pipeline can trigger compaction on real usage
				// rather than a character-based estimate.
				if (
					typeof event.usage.inputTokens === "number" &&
					event.usage.inputTokens > 0
				) {
					ctx.state.lastRequestInputTokens = event.usage.inputTokens;
				}
				await updateUsage(ctx, event.usage);
				break;
			}
			case "finish": {
				finishReason = event.reason;
				ctx.state.lastOutputLimit = event.outputLimit;
				if (event.error) {
					ctx.state.lastError = event.error;
					// Models that classify at their own error boundary (where the
					// raw provider error is still structured) win. Anything else —
					// custom `AgentModel` implementations, adapters that carry only
					// a flattened message — is classified from the message so it
					// stays eligible for overflow recovery.
					ctx.state.lastErrorClass =
						event.errorClass ?? classifyProviderError(event.error);
					// Prefer the boundary's typed `isRetryable` signal; fall back to
					// classifying the flattened message for models that do not carry
					// it.
					ctx.state.lastErrorRetryable =
						event.errorRetryable ?? isRetryableProviderError(event.error);
				}
				break;
			}
		}
	}
	ctx.throwIfAborted();
	const interrupted = steerController.signal.aborted;
	if (interrupted) finishReason = "stop";

	for (const item of sequence) {
		// A cancelled stream may contain incomplete tool JSON or unsigned
		// reasoning. Keep only replayable visible content from that response.
		if (interrupted && (item.type === "tool" || item.part.type === "reasoning"))
			continue;
		if (item.type === "part") {
			content.push(item.part);
			continue;
		}
		const assembly = toolAssemblies.get(item.key);
		if (!assembly?.toolName) {
			invalidToolCalls.push({
				toolCallId: assembly?.toolCallId ?? item.key,
				input: buildInvalidToolInput(assembly?.inputText ?? ""),
				reason: "missing_name",
			});
			continue;
		}
		const parsed = parseToolInput(assembly);
		if (parsed.reason) {
			invalidToolCalls.push({
				toolCallId: assembly.toolCallId,
				toolName: assembly.toolName,
				input: parsed.invalidInput,
				reason: parsed.reason,
			});
		}
		content.push({
			type: "tool-call",
			toolCallId: assembly.toolCallId,
			toolName: assembly.toolName,
			input: parsed.input,
			metadata: parsed.parseError
				? mergeToolMetadata(assembly.metadata, {
						inputParseError: parsed.parseError,
						rawInputText: assembly.inputText,
					})
				: assembly.metadata,
		});
	}

	const messageMetadata: Record<string, unknown> = {};
	if (invalidToolCalls.length > 0) {
		messageMetadata.invalidToolCalls = invalidToolCalls;
	}
	if (modelToolActivities.size > 0) {
		messageMetadata.modelToolActivities = [...modelToolActivities.values()];
	}
	const message = createMessage(
		"assistant",
		content,
		Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
	);
	const metrics = usageDelta(usageBeforeModel, ctx.state.usage);
	if (metrics) {
		message.metrics = metrics;
	}
	if (ctx.config.messageModelInfo) {
		message.modelInfo = { ...ctx.config.messageModelInfo };
	}
	for (const hook of ctx.hooks.afterModel) {
		const control = (await hook({
			snapshot: ctx.snapshot(),
			assistantMessage: message,
			finishReason,
		})) as AgentStopControl | undefined;
		ctx.applyStopControl(control);
	}

	return { message, finishReason, interrupted };
}

async function* openModelStream(
	ctx: AgentLoopContext,
	request: AgentModelRequest,
): AsyncIterable<AgentModelEvent> {
	// A steer aborts the request signal but not the run: end the stream
	// quietly so the loop can pick up the steering message.
	let stream: AsyncIterable<AgentModelEvent>;
	try {
		stream = await ctx.config.model.stream(request);
		ctx.throwIfAborted();
	} catch (error) {
		if (request.signal?.aborted && !ctx.abortController?.signal.aborted) return;
		throw error;
	}

	try {
		for await (const event of stream) {
			yield event;
		}
	} catch (error) {
		if (request.signal?.aborted && !ctx.abortController?.signal.aborted) return;
		throw error;
	}
}

async function prepareTurnForModelRequest(
	ctx: AgentLoopContext,
	request: AgentModelRequest,
	options?: { overflowRecovery?: boolean },
): Promise<AgentModelRequest> {
	if (!ctx.config.prepareTurn) {
		return request;
	}

	const overflowRecovery = options?.overflowRecovery === true;
	const result = await ctx.config.prepareTurn({
		agentId: ctx.state.agentId,
		conversationId: ctx.config.conversationId,
		parentAgentId: ctx.state.parentAgentId ?? null,
		iteration: ctx.state.iteration,
		messages: request.messages,
		systemPrompt: request.systemPrompt,
		tools: request.tools,
		model: {
			id: ctx.config.messageModelInfo?.id,
			provider: ctx.config.messageModelInfo?.provider,
		},
		signal: request.signal,
		overflowRecovery: overflowRecovery || undefined,
		previousRequestInputTokens:
			ctx.state.lastRequestInputTokens > 0
				? ctx.state.lastRequestInputTokens
				: undefined,
		emitStatusNotice: (message, metadata) => {
			void ctx.emit({
				type: "status-notice",
				snapshot: ctx.snapshot(),
				message,
				metadata,
			});
		},
	});
	if (overflowRecovery) {
		// Only retry a provider-rejected overflow with a request that is
		// actually smaller — anything else is guaranteed to fail again.
		//
		// Serialized length is a coarse proxy for tokens, which is all this
		// backstop needs: it answers "did anything get removed at all" for
		// arbitrary `prepareTurn` implementations, and the shared estimator
		// is itself linear in character count, so switching units would not
		// change the verdict. Authoritative token budgeting (against the
		// model's limit) happens inside the compaction pipeline.
		// TODO: have `prepareTurn` report the token estimates it already
		// computed (before/after) so this decision can use real numbers
		// instead of re-deriving a proxy here.
		const shrunk =
			result?.messages !== undefined &&
			JSON.stringify(result.messages).length <
				JSON.stringify(request.messages).length;
		if (!shrunk) {
			throw new ContextWindowOverflowError(
				CONTEXT_WINDOW_OVERFLOW_NOTHING_TO_COMPACT_MESSAGE,
				ctx.state.lastError,
			);
		}
	}
	if (!result) {
		return request;
	}

	let next = request;
	if (result.messages) {
		const preparedMessages = cloneMessages(result.messages);
		next = { ...next, messages: cloneMessages(preparedMessages) };
	}
	if (result.systemPrompt !== undefined) {
		next = { ...next, systemPrompt: result.systemPrompt };
	}
	return next;
}

async function consumePendingUserMessage(
	ctx: AgentLoopContext,
): Promise<AgentMessage | undefined> {
	const consumePendingUserMessage = ctx.config.consumePendingUserMessage;
	if (!consumePendingUserMessage) {
		return undefined;
	}
	const pending = (await consumePendingUserMessage())?.trim();
	if (!pending) {
		return undefined;
	}
	const message = createMessage("user", [{ type: "text", text: pending }], {
		userRunSpan: 0,
	});
	ctx.state.messages.push(message);
	await ctx.emit({
		type: "message-added",
		snapshot: ctx.snapshot(),
		message,
	});
	return message;
}

async function consumeSystemNotice(
	ctx: AgentLoopContext,
): Promise<AgentMessage | undefined> {
	const notice = ctx.config.consumeSystemNotice?.();
	const text = notice?.text.trim();
	if (!text) {
		return undefined;
	}
	// displayRole "system" keeps it out of user-facing transcripts, like the
	// runtime's own reminders.
	const message = createMessage("user", [{ type: "text", text }], {
		userRunSpan: 0,
		displayRole: "system",
		...(notice?.kind ? { kind: notice.kind } : {}),
	});
	ctx.state.messages.push(message);
	await ctx.emit({
		type: "message-added",
		snapshot: ctx.snapshot(),
		message,
	});
	return message;
}

async function updateUsage(
	ctx: AgentLoopContext,
	usage: Partial<AgentUsage>,
): Promise<void> {
	ctx.state.usage = {
		inputTokens: ctx.state.usage.inputTokens + (usage.inputTokens ?? 0),
		outputTokens: ctx.state.usage.outputTokens + (usage.outputTokens ?? 0),
		cacheReadTokens:
			ctx.state.usage.cacheReadTokens + (usage.cacheReadTokens ?? 0),
		cacheWriteTokens:
			ctx.state.usage.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
		reasoningTokenCount:
			(ctx.state.usage.reasoningTokenCount ?? 0) +
			(usage.reasoningTokenCount ?? 0),
		totalCost: (ctx.state.usage.totalCost ?? 0) + (usage.totalCost ?? 0),
		// Not cumulative: reflects only the most recent request, for the
		// per-turn delta event below (see translateUsage in core).
		estimated: usage.estimated,
		contextBreakdown: usage.contextBreakdown,
	};
	await ctx.emit({
		type: "usage-updated",
		snapshot: ctx.snapshot(),
		usage: cloneUsage(ctx.state.usage),
	});
}
