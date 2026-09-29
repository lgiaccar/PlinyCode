import type {
	AgentConfig,
	AgentFinishReason,
	AgentMessage,
	AgentResult,
	AgentRunResult,
	AgentRuntimeEvent,
	AgentSystemNotice,
	LegacyAgentUsage,
	ToolCallRecord,
} from "@plinycode/shared";
import type { ConversationStore } from "../../session/stores/conversation-store";
import type { AgentRuntime } from "../agent";
import { agentMessagesToMessagesWithMetadata } from "../config/agent-message-codec";
import type { LoopDetectionTracker } from "../safety/loop-detection";
import type { MistakeTracker } from "../safety/mistake-tracker";
import {
	deriveFinishReason,
	formatToolResultError,
	tryGetModelInfo,
} from "./session-runtime-helpers";

interface SessionRunTrackerDeps {
	readonly conversation: ConversationStore;
	readonly mistakeTracker: MistakeTracker;
	readonly loopTracker: LoopDetectionTracker;
	readonly loopDetectionDisabled: boolean;
	getConfig(): AgentConfig;
	getActiveRuntime(): AgentRuntime | null;
}

/**
 * Per-run book-keeping for a `SessionRuntime`: tool-call records, usage,
 * the mistake and loop trackers fed from runtime events, and the legacy
 * `AgentResult` built when the run ends.
 */
export class SessionRunTracker {
	/** Running tally of tool-call records for `AgentResult.toolCalls`. */
	private currentRunToolCalls: ToolCallRecord[] = [];
	/** Aggregated usage across the current run. */
	private currentRunUsage: LegacyAgentUsage = {
		inputTokens: 0,
		outputTokens: 0,
	};
	/** Tool-start timestamps for `ToolCallRecord.durationMs`. */
	private toolStartedAt = new Map<string, Date>();
	/** Tool-call input snapshot for `ToolCallRecord.input`. */
	private toolInputs = new Map<string, unknown>();
	/**
	 * Per-turn tool outcome counters used by the MistakeTracker wiring.
	 * Reset on every `turn-started` event; consumed on `turn-finished`
	 * to feed `mistakeTracker.record` when every tool call erred and no
	 * successful call landed. Matches legacy `agent.ts` tool-failure
	 * mistake-feed path (§3.4.6 + pre-Step-9 oracle lines 972-997).
	 */
	private currentTurnSuccessfulTools = 0;
	private currentTurnFailedTools = 0;
	private currentTurnFailureDetails: string[] = [];
	/**
	 * Serial queue for `MistakeTracker.record(...)` + loop-detection
	 * side-effects fired from the sync `handleRuntimeEvent` stream. The
	 * tracker's `record()` is async but the runtime event stream is
	 * synchronous, so we chain tracker work onto a promise and await it
	 * in `executeRun` before returning the `AgentResult`.
	 */
	activeTrackerWork: Promise<void> = Promise.resolve();
	/** True when tracker logic has issued an abort for the active run. */
	private trackerAbortInFlight = false;
	/** Loop-detection notices waiting for the next model request. */
	private pendingSystemNotices: string[] = [];
	private readonly conversation: ConversationStore;
	private readonly mistakeTracker: MistakeTracker;
	private readonly loopTracker: LoopDetectionTracker;
	private readonly loopDetectionDisabled: boolean;

	constructor(private readonly deps: SessionRunTrackerDeps) {
		this.conversation = deps.conversation;
		this.mistakeTracker = deps.mistakeTracker;
		this.loopTracker = deps.loopTracker;
		this.loopDetectionDisabled = deps.loopDetectionDisabled;
	}

	private get config(): AgentConfig {
		return this.deps.getConfig();
	}

	private get activeRuntime(): AgentRuntime | null {
		return this.deps.getActiveRuntime();
	}

	/** Clear the per-run state before a run starts. */
	reset(): void {
		this.currentRunToolCalls = [];
		this.currentRunUsage = { inputTokens: 0, outputTokens: 0 };
		this.toolStartedAt.clear();
		this.toolInputs.clear();
		this.currentTurnSuccessfulTools = 0;
		this.currentTurnFailedTools = 0;
		this.currentTurnFailureDetails = [];
		this.activeTrackerWork = Promise.resolve();
		this.trackerAbortInFlight = false;
		this.pendingSystemNotices = [];
	}

	/** Hands queued loop-detection notices to the runtime, once. */
	consumeSystemNotice(): AgentSystemNotice | undefined {
		if (this.pendingSystemNotices.length === 0) {
			return undefined;
		}
		const text = this.pendingSystemNotices.join("\n\n");
		this.pendingSystemNotices = [];
		return { text, kind: "loop_detection_notice" };
	}

	/** Record one runtime event before it is translated for listeners. */
	record(event: AgentRuntimeEvent): void {
		switch (event.type) {
			case "message-added":
			case "assistant-message": {
				this.syncConversationFromRuntimeMessage(event.snapshot.messages, [
					event.message,
				]);
				break;
			}
			case "turn-started": {
				// Reset per-turn tool-outcome counters used by the
				// MistakeTracker wiring. Parity with pre-Step-9
				// agent.ts which accumulates per-iteration success/fail
				// counts and feeds them into recordMistake at the
				// turn boundary.
				this.currentTurnSuccessfulTools = 0;
				this.currentTurnFailedTools = 0;
				this.currentTurnFailureDetails = [];
				break;
			}
			case "tool-started": {
				this.toolStartedAt.set(event.toolCall.toolCallId, new Date());
				this.toolInputs.set(event.toolCall.toolCallId, event.toolCall.input);
				if (event.toolCall.execution) {
					break;
				}
				// Loop-detection inspection: identical consecutive
				// tool-call signatures trip the tracker. On "soft"
				// verdict we append a recovery notice; on "hard"
				// verdict we feed the mistake tracker with
				// forceAtLimit:true and abort. Parity with pre-Step-9
				// agent.ts L917-954.
				this.inspectLoopForToolCall(
					event.toolCall.toolName,
					event.toolCall.input,
					event.iteration,
				);
				break;
			}
			case "tool-finished": {
				const startedAt = this.toolStartedAt.get(event.toolCall.toolCallId);
				const endedAt = new Date();
				const input = this.toolInputs.get(event.toolCall.toolCallId);
				this.toolStartedAt.delete(event.toolCall.toolCallId);
				this.toolInputs.delete(event.toolCall.toolCallId);
				const resultPart = event.message.content.find(
					(part) => part.type === "tool-result",
				);
				const isError =
					resultPart?.type === "tool-result" && resultPart.isError === true;
				const errorText = isError
					? formatToolResultError(
							resultPart?.type === "tool-result"
								? resultPart.output
								: undefined,
						)
					: undefined;
				const record: ToolCallRecord = {
					id: event.toolCall.toolCallId,
					name: event.toolCall.toolName,
					execution: event.toolCall.execution,
					input,
					output:
						resultPart?.type === "tool-result" ? resultPart.output : undefined,
					error: errorText,
					durationMs:
						startedAt === undefined
							? 0
							: endedAt.getTime() - startedAt.getTime(),
					startedAt: startedAt ?? endedAt,
					endedAt,
				};
				this.currentRunToolCalls.push(record);
				if (event.toolCall.execution) {
					break;
				}
				// Per-turn success/failure bookkeeping for MistakeTracker.
				if (isError) {
					this.currentTurnFailedTools += 1;
					if (errorText) {
						this.currentTurnFailureDetails.push(
							`[${event.toolCall.toolName}] ${errorText}`,
						);
					}
				} else {
					this.currentTurnSuccessfulTools += 1;
				}
				break;
			}
			case "turn-finished": {
				// End-of-turn mistake evaluation: legacy parity (pre-Step-9
				// agent.ts L972-997). When some tool calls failed and the
				// turn had no successful tool calls, record a mistake;
				// reset on productive turns.
				const failed = this.currentTurnFailedTools;
				const succeeded = this.currentTurnSuccessfulTools;
				if (failed > 0 && succeeded === 0) {
					const details = this.currentTurnFailureDetails.join("; ");
					this.enqueueMistakeRecord({
						iteration: event.iteration,
						reason: "tool_execution_failed",
						details: `${failed} tool call(s) failed${
							details ? `: ${details}` : ""
						}`,
					});
				} else if (succeeded > 0) {
					// Productive turn — reset the tracker so transient
					// failures don't accumulate across unrelated turns.
					this.mistakeTracker.reset();
				}
				break;
			}
			case "usage-updated": {
				this.currentRunUsage = {
					inputTokens: event.usage.inputTokens,
					outputTokens: event.usage.outputTokens,
					cacheReadTokens:
						event.usage.cacheReadTokens > 0
							? event.usage.cacheReadTokens
							: undefined,
					cacheWriteTokens:
						event.usage.cacheWriteTokens > 0
							? event.usage.cacheWriteTokens
							: undefined,
					totalCost: event.usage.totalCost,
				};
				break;
			}
			default:
				break;
		}
	}

	private syncConversationFromRuntimeMessage(
		snapshotMessages: readonly AgentMessage[],
		fallbackMessages: readonly AgentMessage[],
	): void {
		if (snapshotMessages.length > 0) {
			this.conversation.replaceMessages(
				agentMessagesToMessagesWithMetadata(snapshotMessages),
			);
			return;
		}
		if (fallbackMessages.length === 0) return;
		const existingIds = new Set(
			this.conversation
				.getMessages()
				.map((message) => message.id)
				.filter((id): id is string => typeof id === "string"),
		);
		const newMessages = agentMessagesToMessagesWithMetadata(
			fallbackMessages,
		).filter((message) => !message.id || !existingIds.has(message.id));
		if (newMessages.length === 0) return;
		this.conversation.replaceMessages([
			...this.conversation.getMessages(),
			...newMessages,
		]);
	}

	/**
	 * Feed the `LoopDetectionTracker` with a tool-call and react to
	 * the returned verdict. Parity with pre-Step-9 agent.ts L917-954:
	 *
	 *   - `"soft"`  → append a recovery notice telling the model to
	 *                 change approach;
	 *   - `"hard"`  → feed `MistakeTracker.record` with
	 *                 `forceAtLimit:true`. When the tracker returns
	 *                 `action: "stop"`, append the stop notice and
	 *                 abort the active runtime.
	 */
	private inspectLoopForToolCall(
		toolName: string,
		input: unknown,
		iteration: number,
	): void {
		if (this.trackerAbortInFlight || this.loopDetectionDisabled) {
			return;
		}
		const verdict = this.loopTracker.inspect({ name: toolName, input });
		if (verdict.kind === "ok") {
			return;
		}
		if (verdict.kind === "soft") {
			// Queued for the runtime rather than appended to the conversation
			// store: the store is rebuilt from the runtime's messages on the next
			// message-added event, which silently dropped the notice before the
			// model ever saw it.
			if (verdict.message) {
				this.pendingSystemNotices.push(verdict.message);
			}
			return;
		}
		// Hard escalation.
		this.enqueueMistakeRecord({
			iteration,
			reason: "tool_execution_failed",
			forceAtLimit: true,
			details:
				verdict.message ??
				`Detected repeated tool calls to \`${toolName}\`; stopping to avoid a loop.`,
		});
	}

	/**
	 * Enqueue a mistake-record onto the serial tracker work chain. The
	 * runtime event stream is synchronous but `MistakeTracker.record`
	 * is async — chaining onto a shared promise preserves ordering
	 * (legacy parity) and lets `executeRun` await draining before
	 * returning the `AgentResult`.
	 *
	 * When the tracker returns `action: "stop"`, append the stop notice
	 * to the conversation and abort the active runtime so the run ends
	 * with `finishReason: "aborted"`.
	 */
	private enqueueMistakeRecord(input: {
		iteration: number;
		reason: "api_error" | "invalid_tool_call" | "tool_execution_failed";
		details?: string;
		forceAtLimit?: boolean;
	}): void {
		if (this.trackerAbortInFlight) {
			return;
		}
		this.activeTrackerWork = this.activeTrackerWork.then(async () => {
			if (this.trackerAbortInFlight) {
				return;
			}
			const outcome = await this.mistakeTracker.record(input);
			if (outcome.action === "stop") {
				this.trackerAbortInFlight = true;
				this.conversation.appendMessage({
					role: "user",
					content: [{ type: "text", text: outcome.message }],
				});
				this.activeRuntime?.abort(outcome.reason ?? outcome.message);
			}
		});
	}

	buildLegacyResult(input: {
		runResult: AgentRunResult | undefined;
		thrownError: Error | undefined;
		startedAt: Date;
		endedAt: Date;
	}): AgentResult {
		const { runResult, thrownError, startedAt, endedAt } = input;
		const durationMs = endedAt.getTime() - startedAt.getTime();
		const finishReason: AgentFinishReason = thrownError
			? "error"
			: deriveFinishReason(runResult);
		const text =
			(runResult?.status === "failed" ? runResult.error?.message : undefined) ||
			runResult?.outputText ||
			"";
		const usage: LegacyAgentUsage = runResult
			? {
					inputTokens: runResult.usage.inputTokens,
					outputTokens: runResult.usage.outputTokens,
					cacheReadTokens:
						runResult.usage.cacheReadTokens > 0
							? runResult.usage.cacheReadTokens
							: undefined,
					cacheWriteTokens:
						runResult.usage.cacheWriteTokens > 0
							? runResult.usage.cacheWriteTokens
							: undefined,
					totalCost: runResult.usage.totalCost,
				}
			: this.currentRunUsage;
		const messages = runResult
			? agentMessagesToMessagesWithMetadata(runResult.messages)
			: this.conversation.getMessages();
		const modelInfo = tryGetModelInfo(this.config);
		if (thrownError) {
			throw thrownError;
		}
		return {
			text,
			usage,
			messages,
			toolCalls: this.currentRunToolCalls,
			iterations: runResult?.iterations ?? 0,
			finishReason,
			model: {
				id: this.config.modelId,
				provider: this.config.providerId,
				info: modelInfo,
			},
			startedAt,
			endedAt,
			durationMs,
		};
	}
}
