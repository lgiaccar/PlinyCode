import {
	type AgentConfig,
	type AgentEvent,
	type AgentResult,
	type AgentRuntimeEvent,
	type BasicLogger,
	isLikelyAuthError,
	type ProviderErrorClass,
} from "@plinycode/shared";
import type { ConversationStore } from "../../session/stores/conversation-store";
import type { RuntimeEventAdapter } from "./runtime-event-adapter";

/**
 * How many times a failed run may be recovered in place (auth refresh or a
 * host-chosen model swap) before the failure is surfaced. Each attempt is a
 * full additional run, so this is deliberately small.
 */
const MAX_RUN_RECOVERY_ATTEMPTS = 3;

interface SessionRunInput {
	userMessage?: string;
	userImages?: string[];
	userFiles?: string[];
	isContinue: boolean;
	offTheRecord?: boolean;
}

interface SessionRunRecoveryDeps {
	readonly agentId: string;
	readonly logger?: BasicLogger;
	readonly conversation: ConversationStore;
	readonly eventAdapter: RuntimeEventAdapter;
	getConfig(): AgentConfig;
	isShutdownCalled(): boolean;
	isAbortRequested(): boolean;
	executeRunInternal(input: SessionRunInput): Promise<AgentResult>;
	emitLegacyEvent(event: AgentEvent): void;
}

/**
 * Recovers failed `SessionRuntime` runs in place (auth refresh or a
 * host-chosen retry), holding back the `run-failed` event until the
 * recovery decision is made.
 */
export class SessionRunRecovery {
	/**
	 * Error class of the most recent `run-failed` runtime event, captured while
	 * the classification is still structured (`AgentResult.text` is flattened).
	 */
	private lastRunFailureClass: ProviderErrorClass | undefined;
	/**
	 * A `run-failed` event held back from listeners while a recovery decision is
	 * pending. Replayed verbatim when the run is not recovered, so a genuinely
	 * terminal failure reaches the host exactly as it does without recovery.
	 */
	private deferredRunFailure: AgentRuntimeEvent | undefined;
	private readonly agentId: string;
	private readonly logger?: BasicLogger;
	private readonly conversation: ConversationStore;
	private readonly eventAdapter: RuntimeEventAdapter;

	constructor(private readonly deps: SessionRunRecoveryDeps) {
		this.agentId = deps.agentId;
		this.logger = deps.logger;
		this.conversation = deps.conversation;
		this.eventAdapter = deps.eventAdapter;
	}

	private get config(): AgentConfig {
		return this.deps.getConfig();
	}

	private get shutdownCalled(): boolean {
		return this.deps.isShutdownCalled();
	}

	private get abortRequested(): boolean {
		return this.deps.isAbortRequested();
	}

	private executeRunInternal(input: SessionRunInput): Promise<AgentResult> {
		return this.deps.executeRunInternal(input);
	}

	private emitLegacyEvent(event: AgentEvent): void {
		this.deps.emitLegacyEvent(event);
	}

	/**
	 * Hold back a `run-failed` event while a recovery decision is pending.
	 * Returns true when the event was deferred.
	 */
	deferRunFailure(event: AgentRuntimeEvent): boolean {
		// A failed run may still be recovered in place by `onRunError` (and the
		// existing auth retry). Reporting the failure now would put the host's UI
		// into its terminal error state even when the very next attempt succeeds,
		// so hold the event until the recovery decision is made. It is replayed
		// by `replayDeferredRunFailure` when the run is not recovered.
		if (event.type === "run-failed" && this.hasRunRecovery()) {
			this.lastRunFailureClass = event.errorClass;
			this.deferredRunFailure = event;
			return true;
		}
		return false;
	}

	/**
	 * Run a turn, recovering failures in place rather than surfacing them.
	 *
	 * Two recovery paths, in order of precedence:
	 *
	 * 1. `config.onAuthError` — an auth-like failure (e.g. an OAuth token that
	 *    expired mid-run). The host refreshes credentials and the run is retried
	 *    once. Unchanged from the original auth-only behavior.
	 * 2. `config.onRunError` — any other failure the host can recover by
	 *    changing the connection, typically by routing the next attempt to a
	 *    different model (an output-token cutoff, a stalled stream, a transport
	 *    death). The host may supply a hidden continuation prompt.
	 *
	 * Both continue from the failed attempt's persisted trail (`isContinue`)
	 * rather than replaying the run, because the partial assistant message was
	 * already written to the conversation store — and its deltas were already
	 * streamed to the UI, where they cannot be retracted.
	 */
	async executeRunWithRecovery(input: SessionRunInput): Promise<AgentResult> {
		let result = await this.executeRunInternal(input);

		for (let attempt = 1; attempt <= MAX_RUN_RECOVERY_ATTEMPTS; attempt += 1) {
			if (result.finishReason !== "error" || this.shutdownCalled) {
				break;
			}
			// An aborted run is the user's decision, never something to recover.
			// (`finishReason` is already narrowed to "error" above; a cancelled
			// run surfaces as an abort request rather than an error finish.)
			if (this.abortRequested) {
				break;
			}

			const errorClass = this.lastRunFailureClass;
			const recovered = await this.attemptRunRecovery({
				result,
				errorClass,
				attempt,
			});
			if (!recovered) {
				break;
			}

			this.discardDeferredRunFailure();
			result = await this.executeRunInternal({ isContinue: true });
		}

		// Whatever the outcome, a failure that was never recovered must still be
		// reported to listeners exactly as it would be without recovery.
		if (result.finishReason === "error") {
			this.replayDeferredRunFailure();
		} else {
			this.discardDeferredRunFailure();
		}
		return result;
	}

	/**
	 * Ask the host whether a failed run can be recovered, and prepare the
	 * conversation for the retry. Returns `undefined` when the run must stay
	 * failed.
	 */
	private async attemptRunRecovery(context: {
		result: AgentResult;
		errorClass: ProviderErrorClass | undefined;
		attempt: number;
	}): Promise<{ kind: "auth" | "run" } | undefined> {
		const { result, errorClass, attempt } = context;

		if (this.config.onAuthError && isLikelyAuthError(result.text)) {
			const refreshed = await this.config.onAuthError().catch(() => false);
			return refreshed ? { kind: "auth" } : undefined;
		}

		if (!this.config.onRunError) {
			return undefined;
		}

		const decision = await this.config
			.onRunError({
				error: result.text,
				errorClass,
				attempt,
				modelId: this.config.modelId,
				hadAssistantContent: this.hasTrailingAssistantContent(),
			})
			.catch((error) => {
				this.logger?.error?.("onRunError hook failed", {
					agentId: this.agentId,
					error,
				});
				return false as const;
			});

		if (!decision || decision.retry !== true) {
			return undefined;
		}

		const continuationPrompt = decision.continuationPrompt?.trim();
		if (continuationPrompt) {
			// `displayRole: "system"` keeps the nudge out of user-facing
			// transcripts (live and replayed) while the model still sees it —
			// the same treatment compaction summaries and hook context get.
			this.conversation.appendMessage({
				role: "user",
				content: [{ type: "text", text: continuationPrompt }],
				metadata: { userRunSpan: 0, displayRole: "system" },
			});
		}
		return { kind: "run" };
	}

	/**
	 * Whether the persisted trail ends with assistant content, i.e. the failed
	 * attempt produced output a retry should continue from rather than repeat.
	 */
	private hasTrailingAssistantContent(): boolean {
		const messages = this.conversation.getMessages();
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role === "assistant") {
				return message.content.length > 0;
			}
			if (message?.role === "user") {
				return false;
			}
		}
		return false;
	}

	/** Whether any hook could recover a failed run in place. */
	private hasRunRecovery(): boolean {
		return Boolean(this.config.onRunError || this.config.onAuthError);
	}

	/** Emit a held-back `run-failed` event, if any. */
	private replayDeferredRunFailure(): void {
		const deferred = this.deferredRunFailure;
		this.deferredRunFailure = undefined;
		if (!deferred) {
			return;
		}
		for (const legacy of this.eventAdapter.translate(deferred)) {
			this.emitLegacyEvent(legacy);
		}
	}

	/** Drop a held-back `run-failed` event because the run was recovered. */
	private discardDeferredRunFailure(): void {
		this.deferredRunFailure = undefined;
	}
}
