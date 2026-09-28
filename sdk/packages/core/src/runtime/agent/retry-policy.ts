import type { AgentMessage, AgentModelFinishReason } from "@plinycode/shared";
import {
	CONTEXT_WINDOW_OVERFLOW_NO_RECOVERY_MESSAGE,
	CONTEXT_WINDOW_OVERFLOW_RECOVERY_FAILED_MESSAGE,
	ContextWindowOverflowError,
} from "./agent-errors";
import type { AgentLoopContext } from "./agent-loop-context";
import { generateAssistantMessage } from "./model-turn";

/**
 * How many times to retry a model turn that failed with a transient,
 * provider-side error (rate limits, 5xx, network hiccups, OpenRouter's
 * generic "Provider returned error"). The initial attempt is not counted, so
 * a value of 3 means up to 4 total requests for one turn. Retrying only
 * transient errors — and never auth, context-overflow, or other client errors
 * (see {@link isRetryableProviderError}) — keeps well-behaved providers on
 * their existing single-request path, so this does not change behavior for
 * models whose endpoints do not throw transient errors.
 */
const PROVIDER_ERROR_MAX_RETRIES = 3;
/** Base backoff before the first retry; doubled each subsequent attempt. */
const PROVIDER_ERROR_RETRY_BASE_DELAY_MS = 1_000;
/** Upper bound on any single backoff wait. */
const PROVIDER_ERROR_RETRY_MAX_DELAY_MS = 15_000;

/**
 * Run a model turn, retrying transient provider/API failures with backoff.
 *
 * A turn whose model stream fails with a retryable provider error (rate
 * limit, 5xx, network hiccup, or OpenRouter's generic "Provider returned
 * error") is re-issued up to {@link PROVIDER_ERROR_MAX_RETRIES} times, with
 * exponential backoff between attempts, before the error is allowed to
 * propagate and end the run. Non-retryable errors (auth, context-window
 * overflow, other client errors) and any attempt that already produced
 * visible output or provider tool activity are returned unchanged for the
 * caller to handle, so this only adds
 * resilience and never changes behavior for a turn that would otherwise
 * succeed. Context-window overflow recovery still runs inside each attempt.
 */
export async function generateAssistantMessageWithProviderRetry(
	ctx: AgentLoopContext,
): Promise<{
	message: AgentMessage;
	finishReason: AgentModelFinishReason;
	interrupted?: boolean;
}> {
	let attempt = 0;
	for (;;) {
		const turn = await generateAssistantMessageWithOverflowRecovery(ctx);
		if (
			attempt >= PROVIDER_ERROR_MAX_RETRIES ||
			!isRetryableProviderErrorTurn(ctx, turn)
		) {
			return turn;
		}
		attempt += 1;
		const providerError = ctx.state.lastError;
		// The failed attempt's error is captured for the notice above; clear it
		// so the next attempt's finish event is judged on its own.
		resetLastError(ctx);
		const delayMs = Math.min(
			PROVIDER_ERROR_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
			PROVIDER_ERROR_RETRY_MAX_DELAY_MS,
		);
		await ctx.emit({
			type: "status-notice",
			snapshot: ctx.snapshot(),
			message: `provider error — retrying (attempt ${attempt}/${PROVIDER_ERROR_MAX_RETRIES})`,
			metadata: {
				kind: "provider_error_retry",
				reason: "provider_error_retry",
				phase: "started",
				iteration: ctx.state.iteration,
				attempt,
				maxRetries: PROVIDER_ERROR_MAX_RETRIES,
				delayMs,
				providerError,
			},
		});
		await abortableDelay(ctx, delayMs);
	}
}

/**
 * True when a turn failed with a transient provider error that a retry
 * could plausibly recover, and the failed attempt left nothing behind that
 * a second stream would duplicate or repeat:
 * - no content at all (text, reasoning, media, or local tool calls): those
 *   deltas were already emitted to the UI and there is no event to retract
 *   them, so re-streaming would show the output twice;
 * - no provider-executed tool activity (recorded in message metadata, not
 *   content): re-issuing the request could run those side effects again;
 * - not an auth or context-window failure, which the same request cannot fix.
 */
function isRetryableProviderErrorTurn(
	ctx: AgentLoopContext,
	turn: {
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
	},
): boolean {
	if (turn.finishReason !== "error") {
		return false;
	}
	if (turn.message.content.length > 0) {
		return false;
	}
	const modelToolActivities = turn.message.metadata?.modelToolActivities;
	if (Array.isArray(modelToolActivities) && modelToolActivities.length > 0) {
		return false;
	}
	const errorClass = ctx.state.lastErrorClass;
	if (errorClass === "auth" || errorClass === "context_window_exceeded") {
		return false;
	}
	// Set from the model boundary's typed `isRetryable` flag when available,
	// otherwise classified from the flattened message in the finish handler.
	return ctx.state.lastErrorRetryable === true;
}

/**
 * Clear the last-error fields. Called at the start of every turn and before
 * every provider-error retry, so a `finish` event that omits `error` (allowed
 * by the public AgentModel contract) cannot inherit the class or retryability
 * of an earlier attempt. Deliberately not called inside overflow recovery,
 * whose "nothing to compact" error reports the first attempt's provider
 * message.
 */
export function resetLastError(ctx: AgentLoopContext): void {
	ctx.state.lastError = undefined;
	ctx.state.lastErrorClass = undefined;
	ctx.state.lastErrorRetryable = undefined;
}

/**
 * Sleep for `ms`, rejecting early with the abort error if the run is
 * aborted while waiting, so a retry backoff never blocks cancellation.
 */
async function abortableDelay(
	ctx: AgentLoopContext,
	ms: number,
): Promise<void> {
	ctx.throwIfAborted();
	const signal = ctx.abortController?.signal;
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(ctx.normalizeAbortError());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

/**
 * Run a model turn, recovering once per run from a provider-rejected
 * context-window overflow: force a compaction through `prepareTurn` and
 * retry the request. Terminal (unrecoverable) overflow states throw with
 * an actionable message instead of the raw provider error.
 */
async function generateAssistantMessageWithOverflowRecovery(
	ctx: AgentLoopContext,
): Promise<{
	message: AgentMessage;
	finishReason: AgentModelFinishReason;
	interrupted?: boolean;
}> {
	const first = await generateAssistantMessage(ctx);
	if (!isRecoverableOverflowTurn(ctx, first)) {
		return first;
	}
	ctx.overflowRecoveryAttempted = true;
	const providerError = ctx.state.lastError;
	if (!ctx.config.prepareTurn) {
		throw new ContextWindowOverflowError(
			CONTEXT_WINDOW_OVERFLOW_NO_RECOVERY_MESSAGE,
			providerError,
		);
	}
	await ctx.emit({
		type: "status-notice",
		snapshot: ctx.snapshot(),
		message: "context window exceeded — compacting and retrying",
		metadata: {
			kind: "context_overflow_recovery",
			reason: "context_overflow_recovery",
			phase: "started",
			iteration: ctx.state.iteration,
			providerError,
		},
	});
	const retry = await generateAssistantMessage(ctx, {
		overflowRecovery: true,
	});
	if (
		retry.finishReason === "error" &&
		ctx.state.lastErrorClass === "context_window_exceeded"
	) {
		throw new ContextWindowOverflowError(
			CONTEXT_WINDOW_OVERFLOW_RECOVERY_FAILED_MESSAGE,
			ctx.state.lastError,
		);
	}
	return retry;
}

function isRecoverableOverflowTurn(
	ctx: AgentLoopContext,
	turn: {
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
	},
): boolean {
	if (
		turn.finishReason !== "error" ||
		ctx.state.lastErrorClass !== "context_window_exceeded" ||
		ctx.overflowRecoveryAttempted
	) {
		return false;
	}
	// An errored stream that still produced tool calls proceeds through the
	// normal loop (matching existing behavior); a retry would discard that
	// partial work.
	return !turn.message.content.some((part) => part.type === "tool-call");
}
