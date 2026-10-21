import {
	CHARS_PER_TOKEN,
	estimateRequestInputTokens,
	tokenCalibration,
} from "@plinycode/shared";
import {
	createSessionCompactionState,
	projectSessionCompactionState,
	type SessionCompactionState,
} from "../../session/models/session-compaction";
import { isUserRunMessage } from "../../session/user-run-messages";
import type {
	CoreCompactionConfig,
	CoreCompactionContext,
	CoreCompactionMode,
	CoreCompactionResult,
	CoreCompactionStrategy,
	CoreSessionConfig,
} from "../../types/config";
import type { ProviderConfig } from "../../types/provider-settings";
import { runAgenticCompaction } from "./agentic-compaction";
import { runBasicCompaction } from "./basic-compaction";
import {
	COMPACTION_TRIGGER_RATIO,
	createTokenEstimator,
	DEFAULT_MAX_INPUT_TOKENS,
	DEFAULT_PRESERVE_RECENT_TOKENS,
	DEFAULT_TARGET_RATIO,
	findLatestSummaryIndex,
	MAX_INPUT_UNDERESTIMATE_FACTOR,
	MESSAGE_TARGET_FLOOR_RATIO,
	MIN_INPUT_UNDERESTIMATE_FACTOR,
	MIN_PRESERVE_RECENT_TOKENS,
	resolveEffectiveMaxInputTokens,
} from "./compaction-shared";

export interface ContextPipelinePrepareTurnInput {
	agentId: string;
	conversationId: string;
	parentAgentId: string | null;
	iteration: number;
	messages: CoreCompactionContext["messages"];
	apiMessages: CoreCompactionContext["messages"];
	abortSignal: AbortSignal;
	systemPrompt: string;
	tools: unknown[];
	model: CoreCompactionContext["model"];
	/**
	 * Set by the runtime when the provider rejected the previous request as
	 * exceeding the model's context window. Forces a compaction regardless of
	 * the token-estimate trigger (the estimate just proved wrong) and uses the
	 * deterministic basic strategy — recovery must not depend on another
	 * successful LLM request.
	 */
	overflowRecovery?: boolean;
	/**
	 * Actual provider-reported input tokens for the previous request this run,
	 * used as a floor on the char-based estimate so dense content still triggers
	 * compaction. See AgentPrepareTurnContext.previousRequestInputTokens.
	 */
	previousRequestInputTokens?: number;
	/**
	 * The previous request's provider-reported and estimated sizes. The ratio
	 * of the two says how far the estimate was off for this conversation's
	 * content and scales the budget; see AgentPrepareTurnContext.previousRequest.
	 */
	previousRequest?: {
		inputTokens: number;
		estimatedTokens: number;
		iteration: number;
	};
	/**
	 * Turns canonical messages into what would be sent: reasoning of earlier
	 * turns dropped, stale context pruned, provider message builders applied.
	 * The state-aware wrapper sizes a compacted projection with it, so the
	 * trigger and the result check see the pruned request, as they do before
	 * the first compaction (session-runtime-orchestrator.ts).
	 */
	pruneForApi?: (
		messages: CoreCompactionContext["messages"],
	) => Promise<CoreCompactionContext["messages"]>;
	emitStatusNotice?: (
		message: string,
		metadata?: Record<string, unknown>,
	) => void;
}

export interface ContextPipelinePrepareTurnResult {
	messages: CoreCompactionContext["messages"];
	systemPrompt?: string;
}

export type ContextPipelinePrepareTurn = (
	context: ContextPipelinePrepareTurnInput,
) => Promise<ContextPipelinePrepareTurnResult | undefined>;

type EstimateMessageTokens = ReturnType<typeof createTokenEstimator>;

type BuiltinCompactionStrategyOptions = {
	context: CoreCompactionContext;
	providerConfig: ProviderConfig;
	compaction: CoreCompactionConfig | undefined;
	estimateMessageTokens: EstimateMessageTokens;
	logger: Pick<CoreSessionConfig, "logger">["logger"];
};

type BuiltinCompactionStrategyRunner = (
	options: BuiltinCompactionStrategyOptions,
) =>
	| Promise<CoreCompactionResult | undefined>
	| CoreCompactionResult
	| undefined;

export interface ContextCompactionPrepareTurnOptions {
	mode?: CoreCompactionMode;
	manualTargetRatio?: number;
}

const LONG_CONVERSATION_TARGET_RATIO = 0.5;

/** Iterations a session rests after a compaction that did not shrink the request. */
const INEFFECTIVE_COMPACTION_COOLDOWN_ITERATIONS = 6;
/** A compaction must save at least this share of the request to be kept. */
const MIN_COMPACTION_GAIN_RATIO = 0.1;
/**
 * The gain check applies from this request size on: below it the summary
 * message's own headings outweigh what was folded, which says nothing about
 * whether compacting helps.
 */
const MIN_GAIN_CHECK_REQUEST_TOKENS = 2_000;

/**
 * How much of the recent transcript the agentic strategy keeps verbatim: the
 * configured amount (20k tokens by default), but never more than the message
 * target, and never less than a floor that keeps the working set usable when
 * a large fixed overhead (system prompt, tools) eats most of the budget. A
 * configured 0 (the imported-history policy) stays 0.
 */
export function resolvePreserveRecentTokens(
	configured: number | undefined,
	messageTargetTokens: number,
): number {
	const requested = configured ?? DEFAULT_PRESERVE_RECENT_TOKENS;
	return Math.max(
		0,
		Math.min(
			requested,
			Math.max(
				MIN_PRESERVE_RECENT_TOKENS,
				Math.floor(messageTargetTokens * 0.5),
			),
			messageTargetTokens,
		),
	);
}

function formatTokens(value: number): string {
	return `${(value / 1000).toFixed(1)}k`;
}

function isCompactionCancellation(
	error: unknown,
	abortSignal: AbortSignal,
): boolean {
	if (abortSignal.aborted) {
		return true;
	}
	return (
		error instanceof Error &&
		(error.name === "AbortError" || error.name === "AgentRuntimeAbortError")
	);
}

function describeCompactionError(error: unknown): Record<string, unknown> {
	return error instanceof Error
		? { errorName: error.name, errorMessage: error.message }
		: { errorMessage: String(error) };
}

function safeJsonSize(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return String(value).length;
	}
}

function summarizeToolResults(messages: CoreCompactionContext["messages"]): {
	toolResultCount: number;
	toolResultSerializedChars: number;
	maxToolResultSerializedChars: number;
} {
	let toolResultCount = 0;
	let toolResultSerializedChars = 0;
	let maxToolResultSerializedChars = 0;
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.type !== "tool_result") {
				continue;
			}
			const size = safeJsonSize(block.content);
			toolResultCount += 1;
			toolResultSerializedChars += size;
			maxToolResultSerializedChars = Math.max(
				maxToolResultSerializedChars,
				size,
			);
		}
	}
	return {
		toolResultCount,
		toolResultSerializedChars,
		maxToolResultSerializedChars,
	};
}

const BUILTIN_COMPACTION_STRATEGIES = {
	basic: ({ context, estimateMessageTokens, logger }) =>
		runBasicCompaction({
			context,
			estimateMessageTokens,
			logger,
		}),
	agentic: ({
		context,
		providerConfig,
		compaction,
		estimateMessageTokens,
		logger,
	}) =>
		runAgenticCompaction({
			context,
			providerConfig,
			summarizer: compaction?.summarizer,
			preserveRecentTokens: resolvePreserveRecentTokens(
				compaction?.preserveRecentTokens,
				context.budget.messages.targetTokens,
			),
			estimateMessageTokens,
			logger,
		}),
} satisfies Record<CoreCompactionStrategy, BuiltinCompactionStrategyRunner>;

function resolveManualMessageTargetTokens(input: {
	messageInputTokens: number;
	messageTriggerTokens: number;
	manualTargetRatio: number | undefined;
}): number {
	const ratio =
		typeof input.manualTargetRatio === "number" &&
		Number.isFinite(input.manualTargetRatio)
			? input.manualTargetRatio
			: 0.5;
	const targetRatio = Math.min(0.95, Math.max(0.05, ratio));
	return Math.max(
		1,
		Math.floor(
			Math.min(
				input.messageTriggerTokens,
				input.messageInputTokens * targetRatio,
			),
		),
	);
}

function resolveAutoRequestTargetTokens(input: {
	maxInputTokens: number;
	modelMaxTokens?: number;
	triggerTokens: number;
	typedTurnCount: number;
}): number {
	const targetTokens =
		input.typedTurnCount >= 5 &&
		typeof input.modelMaxTokens === "number" &&
		Number.isFinite(input.modelMaxTokens) &&
		input.modelMaxTokens < input.maxInputTokens
			? Math.floor(input.maxInputTokens * LONG_CONVERSATION_TARGET_RATIO)
			: Math.floor(input.triggerTokens * DEFAULT_TARGET_RATIO);
	const triggerCeiling = Math.max(1, input.triggerTokens - 1);
	return Math.max(
		1,
		Math.min(targetTokens, input.maxInputTokens, triggerCeiling),
	);
}

/** Lowest and highest share of the input limit the trigger can be set to. */
const MIN_COMPACTION_THRESHOLD_RATIO = 0.1;
const MAX_COMPACTION_THRESHOLD_RATIO = 0.95;

/**
 * The share of the input limit at which automatic compaction runs: the
 * configured ratio (read now when it is a function), clamped, or
 * COMPACTION_TRIGGER_RATIO.
 */
function resolveCompactionThresholdRatio(
	configured: CoreCompactionConfig["thresholdRatio"],
): number {
	let value: number | undefined;
	try {
		value = typeof configured === "function" ? configured() : configured;
	} catch {
		value = undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return COMPACTION_TRIGGER_RATIO;
	}
	return Math.min(
		MAX_COMPACTION_THRESHOLD_RATIO,
		Math.max(MIN_COMPACTION_THRESHOLD_RATIO, value),
	);
}

/** Smallest token override honored; anything lower is taken for a mistake. */
const MIN_TOKEN_OVERRIDE = 1_000;

/**
 * A token-count override (read now when it is a function), or undefined when
 * it is unset, not a number or below MIN_TOKEN_OVERRIDE.
 */
function resolveTokenOverride(
	configured: CoreCompactionConfig["maxInputTokensOverride"],
): number | undefined {
	let value: number | undefined;
	try {
		value = typeof configured === "function" ? configured() : configured;
	} catch {
		value = undefined;
	}
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= MIN_TOKEN_OVERRIDE
		? Math.floor(value)
		: undefined;
}

function translateRequestBudgetToMessages(
	requestTokens: number,
	overheadTokens: number,
): number {
	return Math.max(1, Math.floor(requestTokens - overheadTokens));
}

/**
 * The message target of an automatic compaction: the request target less the
 * overhead, but never below a floor (a share of what messages may occupy at
 * the trigger) and never above what fits under the trigger. Without the floor, a 20k-token overhead on a small
 * budget left a target of one token, and only the last tool pair survived.
 */
export function resolveAutoMessageTargetTokens(input: {
	requestTargetTokens: number;
	overheadTokens: number;
	messageTriggerTokens: number;
}): number {
	const ceiling = Math.max(1, input.messageTriggerTokens - 1);
	const floor = Math.min(
		ceiling,
		Math.floor(input.messageTriggerTokens * MESSAGE_TARGET_FLOOR_RATIO),
	);
	const requested = Math.floor(
		input.requestTargetTokens - input.overheadTokens,
	);
	return Math.max(floor, Math.min(requested, ceiling));
}

/** Typed prompts in the transcript; tool loops do not make a conversation long. */
function countTypedTurns(messages: CoreCompactionContext["messages"]): number {
	let count = 0;
	for (const message of messages) {
		if (message.role === "user" && isUserRunMessage(message)) {
			count += 1;
		}
	}
	return count;
}

/**
 * Build the `prepareTurn` callback used by the agent runtime to compact the
 * transcript before each model request.
 */
export function createContextCompactionPrepareTurn(
	config: Pick<
		CoreSessionConfig,
		| "providerConfig"
		| "providerId"
		| "modelId"
		| "compaction"
		| "logger"
		| "sessionId"
	>,
	options: ContextCompactionPrepareTurnOptions = {},
):
	| ((
			context: ContextPipelinePrepareTurnInput,
	  ) => Promise<ContextPipelinePrepareTurnResult | undefined>)
	| undefined {
	const userCompaction = config.compaction;
	if (userCompaction?.enabled !== true) {
		return undefined;
	}

	const providerConfig =
		config.providerConfig ??
		({
			providerId: config.providerId,
			modelId: config.modelId,
		} as ProviderConfig);
	const estimateMessageTokens = createTokenEstimator();
	const strategy = userCompaction?.strategy ?? "agentic";
	const runBuiltinStrategy = BUILTIN_COMPACTION_STRATEGIES[strategy];
	const mode = options.mode ?? "auto";
	const configuredStrategy: "basic" | "agentic" | "custom" =
		userCompaction?.compact ? "custom" : strategy;
	// One prepareTurn serves the lead agent and every sub-agent of a session,
	// so the rest after an ineffective compaction is kept per agent.
	const cooldowns = new Map<string, { untilIteration: number }>();

	return async (context) => {
		const effectiveMode: CoreCompactionMode = context.overflowRecovery
			? "overflow_recovery"
			: mode;
		const apiMessageTokens = context.apiMessages.reduce(
			(total: number, message) => total + estimateMessageTokens(message),
			0,
		);
		const requestInputTokens = estimateRequestInputTokens({
			systemPrompt: context.systemPrompt,
			messages: context.apiMessages,
			tools: context.tools,
		});
		const messageInputTokens = context.messages.reduce(
			(total: number, message) => total + estimateMessageTokens(message),
			0,
		);
		const requestOverheadTokens = Math.max(
			0,
			requestInputTokens - apiMessageTokens,
		);
		const maxInputTokensOverride = resolveTokenOverride(
			userCompaction?.maxInputTokensOverride,
		);
		const targetTokensOverride = resolveTokenOverride(
			userCompaction?.targetTokensOverride,
		);
		const rawMaxInputTokens =
			maxInputTokensOverride ??
			resolveEffectiveMaxInputTokens({
				maxInputTokens: context.model.info?.maxInputTokens,
				contextWindow: context.model.info?.contextWindow,
			}) ??
			DEFAULT_MAX_INPUT_TOKENS;
		// Every number here is in estimate units (CHARS_PER_TOKEN characters per
		// token). The provider's real limit is translated into those units by
		// scaling the whole budget, rather than re-estimating each message at
		// another ratio: trigger, target and the projection's message costs then
		// stay in one unit while corresponding to the provider's real limit;
		// raising only the trigger would start a compaction that then retains
		// too much and still overflows.
		//
		// Two ratios feed the scale, and the larger (the more conservative) wins:
		// - calibrationFactor: real tokens per estimated token for this model,
		//   learned from the counts providers reported on earlier calls
		//   (tokenCalibration in @plinycode/shared, persisted by the host). 1 for
		//   a model without enough observations. Below 1 it loosens the budget
		//   for a model whose tokenizer packs more characters per token than 3.
		// - underestimateFactor: the provider's actual count for the PREVIOUS
		//   request over our estimate for THAT request. Direct evidence from
		//   this conversation that dense content (disassembly, image dumps,
		//   minified sources) is under-counted, which the per-model average lags
		//   behind. It used to divide the previous count by the CURRENT
		//   estimate, which made the trigger "previous count >= limit" whatever
		//   the current request held: right after a compaction the estimate
		//   shrank, the old count did not, and compaction fired again on every
		//   call until only the last tool pair was left.
		// The scale is capped so a tiny estimate cannot collapse the budget, and
		// floored so a provider that counts only uncached input cannot loosen it.
		const previousRequest =
			context.previousRequest &&
			context.previousRequest.inputTokens >= 1_000 &&
			context.previousRequest.estimatedTokens > 0
				? context.previousRequest
				: undefined;
		const actualPreviousInputTokens = previousRequest?.inputTokens ?? 0;
		const previousEstimatedTokens = previousRequest?.estimatedTokens ?? 0;
		const underestimateFactor = previousRequest
			? Math.min(
					MAX_INPUT_UNDERESTIMATE_FACTOR,
					Math.max(
						MIN_INPUT_UNDERESTIMATE_FACTOR,
						previousRequest.inputTokens / previousRequest.estimatedTokens,
					),
				)
			: 0;
		const calibrationFactor =
			CHARS_PER_TOKEN /
			tokenCalibration.charsPerToken(context.model.id || config.modelId);
		const budgetScale = Math.min(
			MAX_INPUT_UNDERESTIMATE_FACTOR,
			Math.max(calibrationFactor, underestimateFactor),
		);
		const thresholdRatio = resolveCompactionThresholdRatio(
			userCompaction?.thresholdRatio,
		);
		const maxInputTokens = rawMaxInputTokens / budgetScale;
		const requestTriggerTokens = maxInputTokens * thresholdRatio;
		const messageTriggerTokens = translateRequestBudgetToMessages(
			requestTriggerTokens,
			requestOverheadTokens,
		);
		// Equivalent to comparing the provider's actual count against the unscaled
		// trigger, because the budget above already carries the ratio.
		const shouldCompact = requestInputTokens >= requestTriggerTokens;
		const cooldown = cooldowns.get(context.agentId);
		// The rest holds past the hard limit too: the last attempt showed that
		// compacting cannot shrink this request, and a summarizer call per
		// iteration would change nothing. A rejected request gets overflow
		// recovery, which bypasses the rest.
		const inCooldown =
			effectiveMode === "auto" &&
			cooldown !== undefined &&
			context.iteration < cooldown.untilIteration;
		const calibrationCharsPerToken = tokenCalibration.charsPerToken(
			context.model.id || config.modelId,
		);
		const factors = {
			previousInputTokens: actualPreviousInputTokens,
			previousEstimatedTokens,
			previousIteration: previousRequest?.iteration,
			underestimateFactor,
			calibrationCharsPerToken,
			calibrationFactor,
			budgetScale,
		};
		// The numbers go in the message itself: the host's log file keeps only
		// the message unless it runs verbose, and these are what a drifting
		// session needs explained.
		config.logger?.debug(
			`Context compaction diagnostics: E=${formatTokens(requestInputTokens)} T=${formatTokens(requestTriggerTokens)} O=${formatTokens(requestOverheadTokens)} P=${formatTokens(actualPreviousInputTokens)}/E_prev=${formatTokens(previousEstimatedTokens)} scale=${budgetScale.toFixed(2)} -> ${inCooldown ? "cooldown" : shouldCompact ? "compact" : "no"}`,
			{
				mode: effectiveMode,
				strategy,
				iteration: context.iteration,
				providerId: config.providerId,
				modelId: config.modelId,
				requestInputTokens,
				apiMessageTokens,
				messageInputTokens,
				requestOverheadTokens,
				maxInputTokens,
				rawMaxInputTokens,
				maxInputTokensOverride,
				targetTokensOverride,
				...factors,
				requestTriggerTokens,
				messageTriggerTokens,
				thresholdRatio,
				shouldCompact,
				inCooldown,
				messageCount: context.messages.length,
				apiMessageCount: context.apiMessages.length,
				apiMessagesJsonChars: safeJsonSize(context.apiMessages),
				...summarizeToolResults(context.apiMessages),
			},
		);
		if (effectiveMode === "auto" && (!shouldCompact || inCooldown)) {
			return undefined;
		}
		if (
			cooldown !== undefined &&
			context.iteration >= cooldown.untilIteration
		) {
			cooldowns.delete(context.agentId);
		}
		let requestTargetTokens: number;
		let messageTargetTokens: number;
		if (effectiveMode === "auto") {
			// An override is in the provider's tokens, like the budget: the same
			// scale turns it into estimate units, and it stays below the trigger
			// so that a compaction always shrinks the request.
			requestTargetTokens =
				targetTokensOverride !== undefined
					? Math.max(
							1,
							Math.min(
								Math.floor(targetTokensOverride / budgetScale),
								Math.floor(maxInputTokens),
								Math.max(1, Math.floor(requestTriggerTokens) - 1),
							),
						)
					: resolveAutoRequestTargetTokens({
							maxInputTokens,
							modelMaxTokens: context.model.info?.maxTokens,
							triggerTokens: requestTriggerTokens,
							typedTurnCount: countTypedTurns(context.messages),
						});
			messageTargetTokens = resolveAutoMessageTargetTokens({
				requestTargetTokens,
				overheadTokens: requestOverheadTokens,
				messageTriggerTokens,
			});
		} else {
			messageTargetTokens = resolveManualMessageTargetTokens({
				messageInputTokens,
				messageTriggerTokens,
				manualTargetRatio: options.manualTargetRatio,
			});
			requestTargetTokens = requestOverheadTokens + messageTargetTokens;
		}

		const compactionContext = {
			agentId: context.agentId,
			conversationId: context.conversationId,
			parentAgentId: context.parentAgentId,
			iteration: context.iteration,
			messages: context.messages,
			model: context.model,
			mode: effectiveMode,
			abortSignal: context.abortSignal,
			budget: {
				request: {
					inputTokens: requestInputTokens,
					maxInputTokens,
					triggerTokens: requestTriggerTokens,
					targetTokens: requestTargetTokens,
					overheadTokens: requestOverheadTokens,
					thresholdRatio,
					utilizationRatio:
						maxInputTokens > 0 ? requestInputTokens / maxInputTokens : 0,
				},
				messages: {
					inputTokens: messageInputTokens,
					triggerTokens: messageTriggerTokens,
					targetTokens: messageTargetTokens,
				},
			},
		};

		const statusReason =
			effectiveMode === "manual"
				? "manual_compaction"
				: effectiveMode === "overflow_recovery"
					? "overflow_recovery_compaction"
					: "auto_compaction";
		const noticePrefix =
			effectiveMode === "manual"
				? ""
				: effectiveMode === "overflow_recovery"
					? "overflow-recovery-"
					: "auto-";
		const budgetDiagnostics = {
			rawMaxInputTokens,
			maxInputTokens,
			triggerTokens: requestTriggerTokens,
			targetTokens: requestTargetTokens,
			messageTargetTokens,
			preserveRecentTokens: resolvePreserveRecentTokens(
				userCompaction?.preserveRecentTokens,
				messageTargetTokens,
			),
			thresholdRatio,
			...(maxInputTokensOverride !== undefined ? { maxInputTokensOverride } : {}),
			...(targetTokensOverride !== undefined ? { targetTokensOverride } : {}),
		};
		const beforeDiagnostics = {
			messages: context.messages.length,
			estimatedTokens: requestInputTokens,
			chars: safeJsonSize(context.apiMessages),
		};
		const diagnosticsBase = {
			mode: effectiveMode,
			overheadTokens: requestOverheadTokens,
			budget: budgetDiagnostics,
			factors,
			before: beforeDiagnostics,
		};
		context.emitStatusNotice?.(`${noticePrefix}compacting`, {
			kind: statusReason,
			reason: statusReason,
			phase: "started",
			iteration: context.iteration,
			triggerTokens: requestTriggerTokens,
			targetTokens: requestTargetTokens,
			maxInputTokens,
			messageTargetTokens,
			diagnostics: { ...diagnosticsBase, phase: "started" },
		});

		const beforeMessageCount = context.messages.length;
		const compactionStartedAt = Date.now();

		const builtinOptions = {
			context: compactionContext,
			providerConfig: {
				...providerConfig,
				abortSignal: context.abortSignal,
			},
			compaction: userCompaction,
			estimateMessageTokens,
			logger: config.logger,
		};
		let executedStrategy: string = configuredStrategy;
		let result: CoreCompactionResult | undefined;
		if (effectiveMode === "overflow_recovery") {
			// The provider already rejected the request, so recovery must end
			// deterministically: the agentic strategy's own summarizer call could
			// overflow the same window (its input budgeting trusts the same
			// estimator that just undercounted). A custom compactor gets first
			// shot — it sees mode "overflow_recovery" and owns its transcript
			// invariants — but its result is held to the same bar basic
			// compaction aims for: strictly smaller than the input (the runtime
			// refuses to retry with a request that is not smaller) AND within
			// the recovery token target. A marginal shrink would spend the
			// run's single retry on a request that still cannot fit. On throw,
			// decline, or an insufficient result, basic compaction runs so
			// recovery never depends on another successful LLM request.
			if (userCompaction?.compact) {
				try {
					result = await userCompaction.compact(compactionContext);
				} catch (error) {
					if (isCompactionCancellation(error, context.abortSignal)) {
						throw error;
					}
					config.logger?.log(
						"Custom compaction failed during overflow recovery; falling back to basic compaction",
						{
							severity: "warn",
							...describeCompactionError(error),
						},
					);
					result = undefined;
				}
				if (result?.messages) {
					const customMessageTokens = result.messages.reduce(
						(total: number, message) => total + estimateMessageTokens(message),
						0,
					);
					// The full acceptance bar, covering every degenerate size: a
					// non-empty transcript (an empty one erases the request being
					// retried), strictly smaller than the input (the runtime
					// refuses a retry that is not smaller), and within the
					// recovery token target (a marginal shrink spends the run's
					// single retry on a request that still cannot fit). Both size
					// comparisons use the token estimator rather than serialized
					// length so they are expressed in the same unit as the target.
					const acceptable =
						result.messages.length > 0 &&
						customMessageTokens < messageInputTokens &&
						customMessageTokens <= messageTargetTokens;
					if (!acceptable) {
						config.logger?.log(
							"Custom compaction did not produce an acceptable overflow-recovery transcript; falling back to basic compaction",
							{
								severity: "warn",
								customMessageCount: result.messages.length,
								customMessageTokens,
								messageTargetTokens,
							},
						);
						result = undefined;
					}
				}
			}
			if (!result?.messages) {
				executedStrategy = "basic";
				result = await BUILTIN_COMPACTION_STRATEGIES.basic(builtinOptions);
			}
		} else if (userCompaction?.compact) {
			result = await userCompaction.compact(compactionContext);
		} else {
			try {
				result = await runBuiltinStrategy(builtinOptions);
			} catch (error) {
				if (
					strategy !== "agentic" ||
					isCompactionCancellation(error, context.abortSignal)
				) {
					throw error;
				}
				config.logger?.log(
					"Agentic compaction failed; falling back to basic compaction",
					{
						severity: "warn",
						...describeCompactionError(error),
					},
				);
				executedStrategy = "basic";
				result = await BUILTIN_COMPACTION_STRATEGIES.basic(builtinOptions);
			}
			// The agentic strategy never cuts before the latest typed prompt and
			// folds nothing twice, so once everything before that prompt is in a
			// summary it returns nothing, and the request would go out as it is
			// until the provider rejected it. Basic compaction can trim inside
			// the latest turn, so it runs then. A summary that leaves the request
			// over the trigger is not retried here: the next model call compacts
			// again, finds nothing new to fold, and lands in this branch.
			if (
				strategy === "agentic" &&
				!result?.messages &&
				!context.abortSignal?.aborted
			) {
				config.logger?.log(
					"Agentic compaction found nothing to fold; falling back to basic compaction",
					{ severity: "warn", requestTriggerTokens },
				);
				const basicResult =
					await BUILTIN_COMPACTION_STRATEGIES.basic(builtinOptions);
				if (basicResult?.messages) {
					executedStrategy = "basic";
					result = basicResult;
				}
			}
		}

		// Sized the way the request will be sent, like the input was.
		const sizeResult = async (candidate: CoreCompactionResult) => {
			const apiMessages = context.pruneForApi
				? await context.pruneForApi(candidate.messages)
				: candidate.messages;
			const messageTokens = apiMessages.reduce(
				(total: number, message) => total + estimateMessageTokens(message),
				0,
			);
			return {
				requestTokens: requestOverheadTokens + messageTokens,
				chars: safeJsonSize(apiMessages),
			};
		};
		const minimumGain = Math.max(
			1,
			Math.floor(requestInputTokens * MIN_COMPACTION_GAIN_RATIO),
		);
		// A compaction that leaves the request about as large as it was and
		// still over the trigger (a summary as long as what it replaced, a tail
		// that is most of the transcript) would run again on the next call and
		// trim the transcript to nothing. One that got under the trigger is
		// kept whatever it saved: the next call will not compact.
		const isIneffective = (afterTokens: number) =>
			effectiveMode === "auto" &&
			requestInputTokens >= MIN_GAIN_CHECK_REQUEST_TOKENS &&
			afterTokens > requestInputTokens - minimumGain &&
			afterTokens >= requestTriggerTokens;
		let afterSize = result?.messages ? await sizeResult(result) : undefined;
		if (
			result?.messages &&
			afterSize &&
			isIneffective(afterSize.requestTokens) &&
			executedStrategy === "agentic"
		) {
			// The summary folded the old turns but the latest turn is most of
			// the request. Basic compaction trims inside it, on top of the
			// summary, now rather than on the next call.
			config.logger?.log(
				`Agentic compaction left the request at ${formatTokens(afterSize.requestTokens)} est (from ${formatTokens(requestInputTokens)}); trimming inside the latest turn with basic compaction`,
				{ severity: "warn", requestTriggerTokens },
			);
			const trimmed = await BUILTIN_COMPACTION_STRATEGIES.basic({
				...builtinOptions,
				context: { ...compactionContext, messages: result.messages },
			});
			if (trimmed?.messages) {
				const trimmedSize = await sizeResult(trimmed);
				if (trimmedSize.requestTokens < afterSize.requestTokens) {
					result = {
						...trimmed,
						...(result.summarizerUsage
							? { summarizerUsage: result.summarizerUsage }
							: {}),
					};
					afterSize = trimmedSize;
					executedStrategy = "basic";
				}
			}
		}

		if (result?.messages && afterSize) {
			const afterRequestTokens = afterSize.requestTokens;
			const summaryDiagnostics = describeSummaryResult(result);
			const afterDiagnostics = {
				messages: result.messages.length,
				estimatedTokens: afterRequestTokens,
				chars: afterSize.chars,
			};
			if (
				isIneffective(afterRequestTokens) &&
				// Past the hard limit anything smaller beats a rejected request.
				!(
					requestInputTokens >= maxInputTokens &&
					afterRequestTokens < requestInputTokens
				)
			) {
				const untilIteration =
					context.iteration + INEFFECTIVE_COMPACTION_COOLDOWN_ITERATIONS;
				cooldowns.set(context.agentId, { untilIteration });
				if (requestInputTokens >= maxInputTokens) {
					// Nothing more can be folded and the request is over the
					// limit: say so, instead of leaving the rejection to explain it.
					context.emitStatusNotice?.(`${noticePrefix}compaction-insufficient`, {
						kind: statusReason,
						reason: statusReason,
						phase: "insufficient",
						iteration: context.iteration,
						tokensAfter: afterRequestTokens,
						maxInputTokens,
						diagnostics: {
							...diagnosticsBase,
							phase: "insufficient",
							strategy: executedStrategy,
							after: afterDiagnostics,
						},
					});
				}
				config.logger?.log(
					`Context compaction ineffective (${executedStrategy}): ${formatTokens(requestInputTokens)} -> ${formatTokens(afterRequestTokens)} est, needs ${formatTokens(minimumGain)} saved; resting until iteration ${untilIteration}`,
					{
						severity: "warn",
						strategy: executedStrategy,
						requestInputTokens,
						afterRequestTokens,
						minimumGain,
						untilIteration,
					},
				);
				context.emitStatusNotice?.(`${noticePrefix}compaction-skipped`, {
					kind: statusReason,
					reason: statusReason,
					phase: "skipped",
					skipReason: "not_smaller",
					iteration: context.iteration,
					maxInputTokens,
					diagnostics: {
						...diagnosticsBase,
						phase: "skipped",
						skipReason: "not_smaller",
						strategy: executedStrategy,
						cooldownUntilIteration: untilIteration,
						after: afterDiagnostics,
						...summaryDiagnostics,
						durationMs: Date.now() - compactionStartedAt,
					},
				});
				return undefined;
			}
			if (
				effectiveMode === "auto" &&
				executedStrategy === "basic" &&
				afterRequestTokens > requestTriggerTokens
			) {
				// Only one typed message that is itself too large can leave the
				// request over the trigger after basic compaction, which keeps
				// every typed message whole. Say so now, instead of letting the
				// provider's rejection explain it later.
				context.emitStatusNotice?.(`${noticePrefix}compaction-insufficient`, {
					kind: statusReason,
					reason: statusReason,
					phase: "insufficient",
					iteration: context.iteration,
					tokensAfter: afterRequestTokens,
					maxInputTokens,
					diagnostics: {
						...diagnosticsBase,
						phase: "insufficient",
						strategy: executedStrategy,
						after: afterDiagnostics,
					},
				});
			}
			config.logger?.log(
				`Context compaction completed (${executedStrategy}): ${beforeMessageCount}->${result.messages.length} msgs, ${formatTokens(requestInputTokens)}->${formatTokens(afterRequestTokens)} est${summaryDiagnostics.summary ? `, summary ${summaryDiagnostics.summary.chars} chars` : ""}${summaryDiagnostics.summarizer ? `, ${summaryDiagnostics.summarizer.modelId} ${(summaryDiagnostics.summarizer.durationMs / 1000).toFixed(1)}s` : ""}`,
				{
					severity: "info",
					strategy: executedStrategy,
					maxInputTokens,
					messageInputTokens,
					apiInputTokens: apiMessageTokens,
					requestInputTokens,
					requestOverheadTokens,
					afterMessageTokens: afterRequestTokens - requestOverheadTokens,
					afterRequestTokens,
					tokensSaved: requestInputTokens - afterRequestTokens,
					utilizationBefore: `${((requestInputTokens / maxInputTokens) * 100).toFixed(1)}%`,
					utilizationAfter: `${((afterRequestTokens / maxInputTokens) * 100).toFixed(1)}%`,
					thresholdTrigger: `${(thresholdRatio * 100).toFixed(1)}%`,
					messagesBefore: beforeMessageCount,
					messagesAfter: result.messages.length,
					messagesRemoved: beforeMessageCount - result.messages.length,
				} as Record<string, unknown>,
			);
			context.emitStatusNotice?.(`${noticePrefix}compacted`, {
				kind: statusReason,
				reason: statusReason,
				phase: "completed",
				iteration: context.iteration,
				tokensBefore: requestInputTokens,
				tokensAfter: afterRequestTokens,
				messagesBefore: beforeMessageCount,
				messagesAfter: result.messages.length,
				maxInputTokens,
				strategy: executedStrategy,
				...(result.summarizerUsage
					? { summarizerUsage: result.summarizerUsage }
					: {}),
				diagnostics: {
					...diagnosticsBase,
					phase: "completed",
					strategy: executedStrategy,
					after: afterDiagnostics,
					...summaryDiagnostics,
					durationMs: Date.now() - compactionStartedAt,
				},
			});
			if (
				result.budget &&
				(result.budget.actionCount > 0 || result.budget.warningCount > 0)
			) {
				context.emitStatusNotice?.("compaction-budget-adjusted", {
					kind: "compaction_budget_emergency",
					reason: "compaction_budget_emergency",
					iteration: context.iteration,
					policyIntent: result.budget.policyIntent,
					actionCount: result.budget.actionCount,
					warningCount: result.budget.warningCount,
				});
			}
		} else {
			context.emitStatusNotice?.(`${noticePrefix}compaction-skipped`, {
				kind: statusReason,
				reason: statusReason,
				phase: "skipped",
				skipReason: "nothing_to_fold",
				iteration: context.iteration,
				maxInputTokens,
				diagnostics: {
					...diagnosticsBase,
					phase: "skipped",
					skipReason: "nothing_to_fold",
					strategy: executedStrategy,
					durationMs: Date.now() - compactionStartedAt,
				},
			});
		}

		return result;
	};
}

/**
 * What a compaction result says about its summary, for the diagnostics the
 * host traces: the summary message's size and the summarizer's call.
 */
function describeSummaryResult(result: CoreCompactionResult): {
	summary?: {
		chars: number;
		sections: number;
		originalRequestChars: number;
		filesRead: number;
		filesEdited: number;
		hasTodo: boolean;
		hasLastFailure: boolean;
	};
	summarizer?: {
		providerId: string;
		modelId: string;
		durationMs: number;
		inputTokens: number;
		outputTokens: number;
		cost?: number;
	};
} {
	const first = result.messages?.[0];
	const metadata = first?.metadata as Record<string, unknown> | undefined;
	const details = metadata?.details as
		| { readFiles?: unknown; modifiedFiles?: unknown }
		| undefined;
	const summary =
		metadata?.kind === "compaction_summary"
			? {
					chars:
						typeof first?.content === "string"
							? first.content.length
							: (first?.content ?? []).reduce(
									(total, block) =>
										total + (block.type === "text" ? block.text.length : 0),
									0,
								),
					sections: Array.isArray(metadata.sections)
						? metadata.sections.length
						: 0,
					originalRequestChars:
						typeof metadata.originalRequest === "string"
							? metadata.originalRequest.length
							: 0,
					filesRead: Array.isArray(details?.readFiles)
						? details.readFiles.length
						: 0,
					filesEdited: Array.isArray(details?.modifiedFiles)
						? details.modifiedFiles.length
						: 0,
					hasTodo:
						typeof metadata.todo === "string" && metadata.todo.length > 0,
					hasLastFailure:
						typeof metadata.lastFailure === "string" &&
						metadata.lastFailure.length > 0,
				}
			: undefined;
	const usage = result.summarizerUsage;
	const summarizer = usage
		? {
				providerId: usage.providerId,
				modelId: usage.modelId,
				durationMs: usage.durationMs ?? 0,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				...(usage.totalCost !== undefined ? { cost: usage.totalCost } : {}),
			}
		: undefined;
	return {
		...(summary ? { summary } : {}),
		...(summarizer ? { summarizer } : {}),
	};
}

/**
 * Compaction policy for resuming a session imported from another coding agent.
 * The imported transcript keeps that agent's tool names and input schemas
 * verbatim, which a model continuing it may try to call, so the first turn
 * folds the whole foreign history into a summary before the model request
 * (manual mode, agentic strategy, nothing preserved but the new prompt).
 * Runs regardless of the session's auto-compaction setting, tags its status
 * notices with `importedFrom` so clients can label the wait, and on failure
 * falls back to the raw transcript. It makes one attempt per session start
 * (an aborted attempt does not count) and stands down once the working
 * context already opens with a compaction summary, which is how a resumed
 * sidecar presents; every other turn defers to `next`, the session's normal
 * compaction (if any).
 */
export function createImportedHistoryCompactionPrepareTurn(input: {
	config: Parameters<typeof createContextCompactionPrepareTurn>[0];
	/** Source tool id from the session's `importedFrom` metadata. */
	importedFrom: string;
	next?: ContextPipelinePrepareTurn;
}): ContextPipelinePrepareTurn {
	const summarize = createContextCompactionPrepareTurn(
		{
			...input.config,
			compaction: {
				...input.config.compaction,
				enabled: true,
				strategy: "agentic",
				preserveRecentTokens: 0,
			},
		},
		{ mode: "manual" },
	);
	let pending = summarize !== undefined;
	return async (context) => {
		if (pending && summarize && findLatestSummaryIndex(context.messages) < 0) {
			try {
				const result = await summarize({
					...context,
					emitStatusNotice: (message, metadata) =>
						context.emitStatusNotice?.(message, {
							...metadata,
							importedFrom: input.importedFrom,
						}),
				});
				pending = false;
				if (result?.messages) return result;
			} catch (error) {
				if (context.abortSignal.aborted) throw error;
				pending = false;
				input.config.logger?.log(
					"Failed to summarize imported session on resume; continuing with the raw transcript",
					{
						severity: "warn",
						sessionId: input.config.sessionId,
						...describeCompactionError(error),
					},
				);
			}
		}
		return input.next?.(context);
	};
}

export function createCompactionStateAwarePrepareTurn(input: {
	compact?: ContextPipelinePrepareTurn;
	getState?: () => SessionCompactionState | undefined;
	/**
	 * Persist a freshly-computed compaction state. `sourceMessages` are the
	 * exact canonical messages the state's source-prefix hash was computed
	 * over; hosts must validate projection against these rather than a
	 * separately derived transcript, which can legally differ mid-turn and
	 * spuriously reject the write.
	 */
	saveState?: (
		state: SessionCompactionState,
		sourceMessages: CoreCompactionContext["messages"],
	) => void | Promise<void>;
}): ContextPipelinePrepareTurn {
	return async (context) => {
		const existingState = input.getState?.();
		const projectedMessages = existingState
			? projectSessionCompactionState(existingState, context.messages)
			: undefined;
		if (existingState && projectedMessages) {
			// Re-compaction intentionally starts from the compacted projection plus
			// canonical tail. This keeps automatic turns bounded without rebuilding a
			// full-transcript summary every turn; manual `/compact` is the path for a
			// fresh summary from canonical history.
			const result = input.compact
				? await input.compact({
						...context,
						messages: projectedMessages,
						// Sized as it will be sent: pruned and built for the
						// provider, like the request before the first compaction.
						apiMessages: context.pruneForApi
							? await context.pruneForApi(projectedMessages)
							: projectedMessages,
					})
				: undefined;
			if (result?.messages) {
				const systemPrompt = result.systemPrompt ?? existingState.system_prompt;
				const nextState = createSessionCompactionState({
					sourceMessages: context.messages,
					compactedMessages: result.messages,
					conversationId: context.conversationId,
					systemPrompt,
				});
				await input.saveState?.(nextState, context.messages);
				return {
					...result,
					...(systemPrompt !== undefined ? { systemPrompt } : {}),
				};
			}
			return {
				messages: projectedMessages,
				...(result?.systemPrompt !== undefined
					? { systemPrompt: result.systemPrompt }
					: existingState.system_prompt !== undefined
						? { systemPrompt: existingState.system_prompt }
						: {}),
			};
		}
		const result = input.compact ? await input.compact(context) : undefined;
		if (result?.messages) {
			const nextState = createSessionCompactionState({
				sourceMessages: context.messages,
				compactedMessages: result.messages,
				conversationId: context.conversationId,
				systemPrompt: result.systemPrompt,
			});
			await input.saveState?.(nextState, context.messages);
		}
		return result;
	};
}
