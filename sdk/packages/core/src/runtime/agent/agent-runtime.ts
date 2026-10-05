import type {
	AgentMessage,
	AgentMessagePart,
	AgentRunResult,
	AgentRuntimeEvent,
	AgentRuntimeHooks,
	AgentRuntimeStateSnapshot,
	AgentStopControl,
	AgentTool,
	AgentToolCallPart,
} from "@plinycode/shared";
import {
	AgentRuntimeAbortError,
	ContextWindowOverflowError,
	ControlledStopError,
	formatMaxTokensIncompleteTurnMessage,
} from "./agent-errors";
import {
	type AgentLoopContext,
	createAgentRuntimeState,
	type HookBag,
	type ResolvedAgentRuntimeConfig,
} from "./agent-loop-context";
import {
	type AgentRunInput,
	cloneMessages,
	cloneUsage,
	createMessage,
	createUID,
	DEFAULT_USAGE,
	normalizeInput,
	textFromMessage,
	textFromToolMessage,
} from "./agent-messages";
import {
	generateAssistantMessageWithProviderRetry,
	resetLastError,
} from "./retry-policy";
import {
	type AgentRuntimeConfig,
	resolveRuntimeConfig,
} from "./runtime-config";
import { executeToolCalls, findCompletingToolMessage } from "./tool-execution";

export type AgentEventListener = (event: AgentRuntimeEvent) => void;

export class AgentRuntime {
	private config: ResolvedAgentRuntimeConfig;
	private readonly listeners = new Set<AgentEventListener>();
	// biome-ignore lint/suspicious/noExplicitAny: tool input/output types vary per tool
	private readonly tools = new Map<string, AgentTool<any, any>>();
	private hooks: HookBag = {
		beforeRun: [],
		afterRun: [],
		beforeModel: [],
		afterModel: [],
		beforeTool: [],
		afterTool: [],
		onEvent: [],
	};
	/**
	 * `appendContext` blocks collected from beforeTool/afterTool hooks during
	 * the current iteration's tool executions, flushed as one user message
	 * after the tool results so tool-result parts stay contiguous for
	 * providers that require them first in the following turn.
	 */
	private pendingHookContexts: string[] = [];
	/** Index into `state.messages` where the current run's messages begin. */
	private runStartMessageIndex = 0;
	private readonly state = createAgentRuntimeState();
	/** One automatic overflow-recovery attempt per run. */
	private overflowRecoveryAttempted = false;
	private initialization?: Promise<void>;
	private abortController?: AbortController;
	private modelSteerController?: AbortController;
	/**
	 * Aborted when a steering message arrives; handed to tools as
	 * `userMessageSignal`. Replaced whenever pending messages are consumed.
	 */
	private userMessageController = new AbortController();
	/** The view of this runtime handed to the model-turn, retry and tool modules. */
	private readonly loop: AgentLoopContext = this.createLoopContext();

	constructor(config: AgentRuntimeConfig) {
		const resolved = resolveRuntimeConfig(config);
		this.config = {
			...resolved,
			toolExecution: resolved.toolExecution ?? "sequential",
		};
		this.state.agentId = resolved.agentId ?? createUID("agent");
		this.state.agentRole = resolved.agentRole;
		this.state.parentAgentId = resolved.parentAgentId;
		this.state.messages = cloneMessages(resolved.initialMessages ?? []);
	}

	async run(input: AgentRunInput): Promise<AgentRunResult> {
		return this.execute(input);
	}

	async continue(input?: AgentRunInput): Promise<AgentRunResult> {
		return this.execute(input);
	}

	/**
	 * Interrupt the current model request and signal running tools, so the
	 * message is read at once. Tools that only pass time (wait, a long command)
	 * return early; other tools finish normally.
	 */
	notifyPendingUserMessage(): void {
		this.modelSteerController?.abort();
		this.userMessageController.abort();
	}

	abort(reason?: unknown): void {
		if (!this.abortController) {
			return;
		}
		if (this.abortController.signal.aborted) {
			return;
		}
		const abortError =
			reason instanceof AgentRuntimeAbortError
				? reason
				: new AgentRuntimeAbortError(reason);
		this.state.lastError = abortError.message;
		this.abortController.abort(abortError);
	}

	subscribe(listener: AgentEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Replace the conversation with a fresh set of messages, discarding any
	 * in-flight run and usage state while preserving the underlying model,
	 * tools, hooks, plugins, and active event subscribers.
	 *
	 * Useful for standalone callers that persist conversations externally and
	 * want to re-seed the runtime from storage without recreating subscribers.
	 */
	restore(messages: readonly AgentMessage[]): void {
		this.abort("Agent state restored");
		// Reset state that is not carried across restores. Keep `listeners`,
		// tools, hooks, plugins, model, and agent identity so external event
		// subscribers continue to receive events after restore().
		this.state.runId = undefined;
		this.state.status = "idle";
		this.state.iteration = 0;
		this.state.pendingToolCalls = [];
		this.state.usage = cloneUsage(DEFAULT_USAGE);
		this.state.lastError = undefined;
		this.state.lastErrorClass = undefined;
		this.state.lastErrorRetryable = undefined;
		this.state.messages = cloneMessages(messages);
		this.config = {
			...this.config,
			initialMessages: cloneMessages(messages),
		};
	}

	snapshot(): AgentRuntimeStateSnapshot {
		return {
			agentId: this.state.agentId,
			agentRole: this.state.agentRole,
			parentAgentId: this.state.parentAgentId,
			conversationId: this.config.conversationId?.trim() || undefined,
			runId: this.state.runId,
			status: this.state.status,
			iteration: this.state.iteration,
			messages: cloneMessages(this.state.messages),
			pendingToolCalls: [...this.state.pendingToolCalls],
			usage: cloneUsage(this.state.usage),
			lastError: this.state.lastError,
			lastErrorClass: this.state.lastErrorClass,
		};
	}

	private createLoopContext(): AgentLoopContext {
		const runtime = this;
		return {
			get config() {
				return runtime.config;
			},
			state: this.state,
			tools: this.tools,
			hooks: this.hooks,
			get pendingHookContexts() {
				return runtime.pendingHookContexts;
			},
			set pendingHookContexts(value) {
				runtime.pendingHookContexts = value;
			},
			get overflowRecoveryAttempted() {
				return runtime.overflowRecoveryAttempted;
			},
			set overflowRecoveryAttempted(value) {
				runtime.overflowRecoveryAttempted = value;
			},
			get abortController() {
				return runtime.abortController;
			},
			get modelSteerController() {
				return runtime.modelSteerController;
			},
			set modelSteerController(value) {
				runtime.modelSteerController = value;
			},
			get userMessageController() {
				return runtime.userMessageController;
			},
			set userMessageController(value) {
				runtime.userMessageController = value;
			},
			snapshot: () => this.snapshot(),
			emit: (event) => this.emit(event),
			applyStopControl: (control) => this.applyStopControl(control),
			throwIfAborted: () => this.throwIfAborted(),
			normalizeAbortError: () => this.normalizeAbortError(),
		};
	}

	private async ensureInitialized(): Promise<void> {
		this.initialization ??= this.initialize();
		await this.initialization;
	}

	private async initialize(): Promise<void> {
		this.registerHooks(this.config.hooks);
		for (const tool of this.config.tools ?? []) {
			this.tools.set(tool.name, tool);
		}
		for (const plugin of this.config.plugins ?? []) {
			const setup = await plugin.setup?.({
				agentId: this.state.agentId,
				agentRole: this.state.agentRole,
				systemPrompt: this.config.systemPrompt,
			});
			for (const tool of setup?.tools ?? []) {
				this.tools.set(tool.name, tool);
			}
			this.registerHooks(setup?.hooks);
		}
	}

	private registerHooks(hooks: Partial<AgentRuntimeHooks> | undefined): void {
		if (!hooks) {
			return;
		}
		if (hooks.beforeRun) this.hooks.beforeRun.push(hooks.beforeRun);
		if (hooks.afterRun) this.hooks.afterRun.push(hooks.afterRun);
		if (hooks.beforeModel) this.hooks.beforeModel.push(hooks.beforeModel);
		if (hooks.afterModel) this.hooks.afterModel.push(hooks.afterModel);
		if (hooks.beforeTool) this.hooks.beforeTool.push(hooks.beforeTool);
		if (hooks.afterTool) this.hooks.afterTool.push(hooks.afterTool);
		if (hooks.onEvent) this.hooks.onEvent.push(hooks.onEvent);
	}

	private getRequiredCompletionToolNames(): string[] {
		if (this.config.completionPolicy?.requireCompletionTool !== true) {
			return [];
		}
		return [...this.tools.values()]
			.filter((tool) => tool.lifecycle?.completesRun === true)
			.map((tool) => tool.name)
			.sort();
	}

	private getCompletionToolReminderMessage(): string | undefined {
		const terminalToolNames = this.getRequiredCompletionToolNames();
		if (terminalToolNames.length === 0) {
			return undefined;
		}
		return `[SYSTEM] This run is not complete until you call one of these terminal completion tools: ${terminalToolNames.join(
			", ",
		)}. Continue working if requirements are not met. If the task is complete, call the appropriate terminal completion tool now.`;
	}

	private async getCompletionReminderMessages(
		message: AgentMessage,
	): Promise<string[]> {
		return [
			this.getCompletionToolReminderMessage(),
			await this.config.completionPolicy?.completionGuard?.({
				message,
				iteration: this.state.iteration,
				runMessages: this.state.messages.slice(this.runStartMessageIndex),
				messages: this.state.messages,
				signal: this.abortController?.signal,
			}),
		].filter((reminder): reminder is string => Boolean(reminder));
	}

	private async addUserReminderMessage(text: string): Promise<AgentMessage> {
		// displayRole "system" keeps the reminder out of user-facing transcripts:
		// it is model-facing, and hosts announce it their own way.
		const reminderMessage = createMessage("user", [{ type: "text", text }], {
			userRunSpan: 0,
			displayRole: "system",
		});
		this.state.messages.push(reminderMessage);
		await this.emit({
			type: "message-added",
			snapshot: this.snapshot(),
			message: reminderMessage,
		});
		return reminderMessage;
	}

	private async execute(input?: AgentRunInput): Promise<AgentRunResult> {
		await this.ensureInitialized();
		if (this.state.status === "running") {
			throw new Error("Agent runtime is already running");
		}

		this.abortController = new AbortController();
		// A steer notified during the previous run was consumed or drained as
		// this run's prompt; it must not cut this run's tools short.
		this.userMessageController = new AbortController();
		this.state.runId = createUID("run");
		this.state.status = "running";
		this.state.iteration = 0;
		this.runStartMessageIndex = this.state.messages.length;
		this.state.pendingToolCalls = [];
		this.state.lastError = undefined;
		this.state.lastErrorClass = undefined;
		this.state.lastErrorRetryable = undefined;
		this.state.usage = cloneUsage(DEFAULT_USAGE);
		this.overflowRecoveryAttempted = false;
		this.state.lastRequestInputTokens = 0;

		try {
			await this.callBeforeRunHooks();
			await this.emit({ type: "run-started", snapshot: this.snapshot() });

			for (const message of input ? normalizeInput(input) : []) {
				this.state.messages.push(message);
				await this.emit({
					type: "message-added",
					snapshot: this.snapshot(),
					message,
				});
			}

			const completionToolReminder = this.getCompletionToolReminderMessage();
			if (completionToolReminder) {
				await this.addUserReminderMessage(completionToolReminder);
			}

			let finalAssistantMessage: AgentMessage | undefined;

			while (
				this.config.maxIterations === undefined ||
				this.state.iteration < this.config.maxIterations
			) {
				this.throwIfAborted();

				this.state.iteration += 1;
				await this.emit({
					type: "turn-started",
					snapshot: this.snapshot(),
					iteration: this.state.iteration,
				});

				// A fresh error slate per turn: nothing from a previous turn may leak
				// into this turn's error classification or retry decision.
				resetLastError(this.loop);
				const { message, finishReason, interrupted } =
					await generateAssistantMessageWithProviderRetry(this.loop);
				if (interrupted && message.content.length === 0) {
					await this.emit({
						type: "turn-finished",
						snapshot: this.snapshot(),
						iteration: this.state.iteration,
						toolCallCount: 0,
					});
					continue;
				}
				if (finishReason === "aborted") {
					throw this.normalizeAbortError();
				}
				if (message.content.length === 0) {
					if (finishReason === "error") {
						throw new Error(this.state.lastError ?? "Model stream failed");
					}
					// Provider-executed tool activity lives in message metadata, not
					// content (projecting it into content would replay tool_use blocks
					// the model never gets results for). A turn that is only such
					// activity is not empty: keep the message so the transcript and
					// display projection retain it. Replay stays safe — the codec
					// renders empty content as its placeholder text block.
					const modelToolActivities = message.metadata?.modelToolActivities;
					const hasModelToolActivity =
						Array.isArray(modelToolActivities) &&
						modelToolActivities.length > 0;
					if (!hasModelToolActivity) {
						throw new Error("Model returned empty response");
					}
				}
				const toolCalls = message.content.filter(
					(part: AgentMessagePart): part is AgentToolCallPart =>
						part.type === "tool-call",
				);

				finalAssistantMessage = message;
				this.state.messages.push(message);
				await this.emit({
					type: "message-added",
					snapshot: this.snapshot(),
					message,
				});
				await this.emit({
					type: "assistant-message",
					snapshot: this.snapshot(),
					iteration: this.state.iteration,
					message,
					finishReason,
				});

				if (interrupted) {
					await this.emit({
						type: "turn-finished",
						snapshot: this.snapshot(),
						iteration: this.state.iteration,
						toolCallCount: 0,
					});
					continue;
				}

				if (finishReason === "max-tokens" && toolCalls.length === 0) {
					throw new Error(
						formatMaxTokensIncompleteTurnMessage({
							outputLimit: this.state.lastOutputLimit,
							modelId: this.config.messageModelInfo?.id,
							outputTokens: message.metrics?.outputTokens,
							inputTokens: this.state.lastRequestInputTokens,
						}),
					);
				}
				if (finishReason === "error" && toolCalls.length === 0) {
					throw new Error(this.state.lastError ?? "Model stream failed");
				}
				this.state.pendingToolCalls = toolCalls.map((part) => part.toolCallId);

				if (toolCalls.length === 0) {
					await this.emit({
						type: "turn-finished",
						snapshot: this.snapshot(),
						iteration: this.state.iteration,
						toolCallCount: 0,
					});
					const completionReminderMessages =
						await this.getCompletionReminderMessages(message);
					if (completionReminderMessages.length > 0) {
						for (const reminderMessage of completionReminderMessages) {
							await this.addUserReminderMessage(reminderMessage);
						}
						continue;
					}
					const result = this.finishRun("completed", finalAssistantMessage);
					await this.callAfterRunHooks(result);
					await this.emit({
						type: "run-finished",
						snapshot: this.snapshot(),
						result,
					});
					return result;
				}

				const toolMessages = await executeToolCalls(this.loop, toolCalls);
				this.state.pendingToolCalls = [];
				for (const toolMessage of toolMessages) {
					this.state.messages.push(toolMessage);
					await this.emit({
						type: "message-added",
						snapshot: this.snapshot(),
						message: toolMessage,
					});
				}
				if (this.pendingHookContexts.length > 0) {
					const hookContextText = this.pendingHookContexts.join("\n\n");
					this.pendingHookContexts = [];
					// displayRole "system" keeps the injected block out of user-facing
					// transcripts (live and replayed) while it still reaches the model,
					// mirroring how compaction summaries are handled.
					const hookContextMessage = createMessage(
						"user",
						[{ type: "text", text: hookContextText }],
						{ userRunSpan: 0, displayRole: "system" },
					);
					this.state.messages.push(hookContextMessage);
					await this.emit({
						type: "message-added",
						snapshot: this.snapshot(),
						message: hookContextMessage,
					});
				}
				await this.emit({
					type: "turn-finished",
					snapshot: this.snapshot(),
					iteration: this.state.iteration,
					toolCallCount: toolCalls.length,
				});
				const terminalToolMessage = findCompletingToolMessage(
					this.loop,
					toolCalls,
					toolMessages,
				);
				if (terminalToolMessage) {
					const result = this.finishRun(
						"completed",
						finalAssistantMessage,
						textFromToolMessage(terminalToolMessage) || undefined,
					);
					await this.callAfterRunHooks(result);
					await this.emit({
						type: "run-finished",
						snapshot: this.snapshot(),
						result,
					});
					return result;
				}
			}

			throw new Error(
				`Agent runtime exceeded maxIterations (${this.config.maxIterations})`,
			);
		} catch (error) {
			const normalized =
				error instanceof Error ? error : new Error(String(error));
			const isControlledStop = normalized instanceof ControlledStopError;
			const isAborted = this.abortController.signal.aborted || isControlledStop;
			const status = isAborted ? "aborted" : "failed";
			// Read before overwriting lastError below: the class only applies
			// when the run failed on the provider error it was recorded for.
			const errorClass =
				normalized instanceof ContextWindowOverflowError
					? ("context_window_exceeded" as const)
					: normalized.message === this.state.lastError
						? this.state.lastErrorClass
						: undefined;
			this.state.status = status;
			this.state.lastError = normalized.message;
			this.state.lastErrorClass = errorClass;
			const lastAssistantMessage = this.findLastAssistantMessage();
			const result: AgentRunResult = {
				agentId: this.state.agentId,
				agentRole: this.state.agentRole,
				runId: this.state.runId ?? createUID("run"),
				status,
				iterations: this.state.iteration,
				outputText: textFromMessage(lastAssistantMessage),
				messages: cloneMessages(this.state.messages),
				usage: cloneUsage(this.state.usage),
				error: status === "failed" ? normalized : undefined,
			};
			this.config.logger?.log?.("Agent loop caught error", {
				severity: status === "failed" ? "error" : "warn",
				agentId: this.state.agentId,
				agentRole: this.state.agentRole,
				runId: result.runId,
				status,
				iteration: this.state.iteration,
				errorName: normalized.name,
				errorMessage: normalized.message,
				assistantContentPartCount: lastAssistantMessage?.content.length ?? 0,
			});
			await this.callAfterRunHooks(result);
			if (status === "failed") {
				await this.emit({
					type: "run-failed",
					snapshot: this.snapshot(),
					error: normalized,
					errorClass,
				});
			} else {
				await this.emit({
					type: "run-finished",
					snapshot: this.snapshot(),
					result,
				});
			}
			return result;
		} finally {
			this.abortController = undefined;
		}
	}

	private async callBeforeRunHooks(): Promise<void> {
		for (const hook of this.hooks.beforeRun) {
			const control = (await hook({
				snapshot: this.snapshot(),
			})) as AgentStopControl | undefined;
			this.applyStopControl(control);
		}
	}

	private async callAfterRunHooks(result: AgentRunResult): Promise<void> {
		for (const hook of this.hooks.afterRun) {
			await hook({ snapshot: this.snapshot(), result });
		}
	}

	private finishRun(
		status: AgentRunResult["status"],
		assistantMessage?: AgentMessage,
		outputText?: string,
	): AgentRunResult {
		this.state.status = status;
		return {
			agentId: this.state.agentId,
			agentRole: this.state.agentRole,
			runId: this.state.runId ?? createUID("run"),
			status,
			iterations: this.state.iteration,
			outputText:
				outputText ??
				textFromMessage(assistantMessage ?? this.findLastAssistantMessage()),
			messages: cloneMessages(this.state.messages),
			usage: cloneUsage(this.state.usage),
		};
	}

	private findLastAssistantMessage(): AgentMessage | undefined {
		return [...this.state.messages]
			.reverse()
			.find((message) => message.role === "assistant");
	}

	private throwIfAborted(): void {
		if (this.abortController?.signal.aborted) {
			throw this.normalizeAbortError();
		}
	}

	private normalizeAbortError(): Error {
		const reason = this.abortController?.signal.reason;
		if (reason instanceof Error) {
			return reason;
		}
		if (typeof reason === "string") {
			return new Error(reason);
		}
		return new Error(this.state.lastError ?? "Run aborted");
	}

	private async emit(event: AgentRuntimeEvent): Promise<void> {
		const metadata = buildEventMetadata(event);
		switch (event.type) {
			case "run-started":
				// Verbatim clinee calls `logger?.info?.(...)`. sdk-re's
				// `BasicLogger` does not declare `info` (it uses `log`), so
				// we narrow to an optional-info shape at the call site to
				// preserve the clinee runtime contract without mutating
				// shared's `BasicLogger` interface.
				(
					this.config.logger as
						| {
								info?: (msg: string, md?: unknown) => void;
						  }
						| undefined
				)?.info?.("Agent run started", metadata);
				break;
			case "tool-finished":
				(
					this.config.logger as
						| {
								info?: (msg: string, md?: unknown) => void;
						  }
						| undefined
				)?.info?.("Agent tool finished", metadata);
				break;
			case "run-failed":
				this.config.logger?.error?.("Agent run failed", {
					...metadata,
					error: event.error,
				});
				break;
			default:
				this.config.logger?.debug?.("Agent event", metadata);
				break;
		}
		for (const listener of this.listeners) {
			listener(event);
		}
		for (const hook of this.hooks.onEvent) {
			await hook(event);
		}
	}

	private applyStopControl(
		control: AgentStopControl | undefined | undefined,
	): void {
		if (!control?.stop) {
			return;
		}
		if (control.reason) {
			this.state.lastError = control.reason;
		}
		throw new ControlledStopError(control.reason);
	}
}

function buildEventMetadata(event: AgentRuntimeEvent): Record<string, unknown> {
	return {
		agentId: event.snapshot.agentId,
		agentRole: event.snapshot.agentRole,
		runId: event.snapshot.runId,
		status: event.snapshot.status,
		iteration: event.snapshot.iteration,
		eventType: event.type,
	};
}

export function createAgentRuntime(config: AgentRuntimeConfig): AgentRuntime {
	return new AgentRuntime(config);
}

/**
 * `Agent` is the user-friendly name for `AgentRuntime`. They are the same
 * class; this alias exists so standalone callers can write:
 *
 *     const agent = new Agent({ providerId, modelId, apiKey });
 *     await agent.run("hello");
 *
 * while `SessionRuntime` (which owns model construction) continues to use
 * the `AgentRuntime` name with `{ model, ... }` configs.
 */
export const Agent = AgentRuntime;
export type Agent = AgentRuntime;

export function createAgent(config: AgentRuntimeConfig): AgentRuntime {
	return new AgentRuntime(config);
}
