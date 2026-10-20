import { createHandlerAsync } from "@plinycode/llms";
import type { BasicLogger } from "@plinycode/shared";
import { countUserRunMessages } from "../../session/user-run-messages";
import type {
	CoreCompactionContext,
	CoreCompactionResult,
	CoreCompactionSummarizerConfig,
} from "../../types/config";
import type { ProviderConfig } from "../../types/provider-settings";
import {
	type BudgetProjectionResult,
	buildBudgetProjection,
} from "./budget-projection";
import type {
	CompactionSummarizerUsage,
	CompactionSummarySection,
	FileOperationSummary,
} from "./compaction-shared";
import {
	buildCondenseRequest,
	buildSummaryMessage,
	buildSummaryRequest,
	carrySummarySections,
	type EstimateMessageTokens,
	estimateTokens,
	extractFileOps,
	extractOriginalRequest,
	findCutIndex,
	findLastTurnStartIndex,
	findLatestSummaryIndex,
	getCompactionSummaryMetadata,
	mergeUnique,
	resolveEffectiveMaxInputTokens,
	resolveSummarizerConfig,
	SUMMARY_CONDENSED_CHAR_LIMIT,
	SUMMARY_SECTIONS_CHAR_LIMIT,
	SUMMARY_SECTIONS_KEPT_VERBATIM,
	sectionsCharLength,
	selectSectionsToCondense,
	serializeConversation,
	stripHostRenderedSections,
	truncateText,
	truncateToolResultsForSummary,
} from "./compaction-shared";
import { extractLastFailure, extractTodoList } from "./summary-state";

const MIN_AGENTIC_SUMMARY_INPUT_TOKENS = 1_024;

function resolveProviderMaxInputTokens(
	providerConfig: ProviderConfig,
): number | undefined {
	const modelInfoLimit = resolveEffectiveMaxInputTokens({
		maxInputTokens:
			providerConfig.maxInputTokens ?? providerConfig.modelInfo?.maxInputTokens,
		contextWindow: providerConfig.modelInfo?.contextWindow,
	});
	if (modelInfoLimit !== undefined) {
		return modelInfoLimit;
	}
	const knownModelInfo = providerConfig.knownModels?.[providerConfig.modelId];
	return resolveEffectiveMaxInputTokens({
		maxInputTokens: knownModelInfo?.maxInputTokens,
		contextWindow: knownModelInfo?.contextWindow,
	});
}

export function buildAgenticSummaryInputBudget(options: {
	messages: CoreCompactionContext["messages"];
	targetTokens: number;
	estimateMessageTokens: EstimateMessageTokens;
}): BudgetProjectionResult {
	return buildBudgetProjection({
		messages: options.messages,
		targetTokens: Math.max(1, options.targetTokens),
		policyIntent: "agentic_summary",
		estimateMessageTokens: options.estimateMessageTokens,
	});
}

interface SummaryGenerationResult {
	text: string;
	/** Reasoning/thinking output length; discarded from the summary itself. */
	reasoningChars: number;
	/** Provider-reported reason the response is incomplete (e.g. "max_output_tokens"). */
	incompleteReason?: string;
	/** The call's tokens and cost, when the stream reported them. */
	usage?: CompactionSummarizerUsage;
	/** How long the call took. */
	durationMs: number;
}

async function generateSummary(options: {
	providerConfig: ProviderConfig;
	request: string;
	systemPrompt?: string;
	logger?: BasicLogger;
}): Promise<SummaryGenerationResult> {
	const startedAt = Date.now();
	const handler = await createHandlerAsync(options.providerConfig);
	let text = "";
	let reasoningChars = 0;
	let incompleteReason: string | undefined;
	let usage: CompactionSummarizerUsage | undefined;
	for await (const chunk of handler.createMessage(
		options.systemPrompt ??
			"Summarize the provided coding session into a concise continuation note with detailed next steps.",
		[{ role: "user", content: options.request }],
	)) {
		if (chunk.type === "text") {
			text += chunk.text;
			continue;
		}
		if (chunk.type === "reasoning") {
			reasoningChars += chunk.reasoning?.length ?? 0;
			continue;
		}
		if (chunk.type === "usage") {
			// The summarizer's call is paid like any other; the host adds it to
			// the conversation's cost. Later chunks carry the running totals.
			usage = {
				providerId: options.providerConfig.providerId,
				modelId: options.providerConfig.modelId,
				inputTokens: chunk.inputTokens ?? 0,
				outputTokens: chunk.outputTokens ?? 0,
				...(chunk.cacheReadTokens !== undefined
					? { cacheReadTokens: chunk.cacheReadTokens }
					: {}),
				...(chunk.cacheWriteTokens !== undefined
					? { cacheWriteTokens: chunk.cacheWriteTokens }
					: {}),
				...(chunk.totalCost !== undefined
					? { totalCost: chunk.totalCost }
					: {}),
			};
			continue;
		}
		if (chunk.type === "done") {
			if (!chunk.success && chunk.error) {
				throw new Error(chunk.error);
			}
			incompleteReason = chunk.incompleteReason ?? incompleteReason;
		}
	}
	const durationMs = Date.now() - startedAt;
	if (usage) {
		usage = { ...usage, durationMs };
	}
	options.logger?.debug(
		`Generated compaction summary: ${text.length} chars, ${options.providerConfig.modelId} ${(durationMs / 1000).toFixed(1)}s${incompleteReason ? `, incomplete: ${incompleteReason}` : ""}`,
		{
			outputChars: text.length,
			reasoningChars,
			incompleteReason,
			modelId: options.providerConfig.modelId,
			providerId: options.providerConfig.providerId,
			durationMs,
			...(usage ? { usage } : {}),
		},
	);
	return {
		text: text.trim(),
		reasoningChars,
		incompleteReason,
		usage,
		durationMs,
	};
}

function safeJsonSize(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return String(value).length;
	}
}

function mergeFileOps(
	base: FileOperationSummary,
	next: FileOperationSummary,
): FileOperationSummary {
	return {
		readFiles: mergeUnique(base.readFiles, next.readFiles),
		modifiedFiles: mergeUnique(base.modifiedFiles, next.modifiedFiles),
	};
}

function renderSectionsForPrompt(
	sections: readonly CompactionSummarySection[],
): string | undefined {
	if (sections.length === 0) {
		return undefined;
	}
	const text = sections
		.map((section) => `### Span ${section.span}\n${section.text.trim()}`)
		.join("\n\n");
	return truncateText(text, SUMMARY_SECTIONS_CHAR_LIMIT);
}

function addSummarizerUsage(
	base: CompactionSummarizerUsage | undefined,
	extra: CompactionSummarizerUsage | undefined,
): CompactionSummarizerUsage | undefined {
	if (!base) {
		return extra;
	}
	if (!extra) {
		return base;
	}
	return {
		...base,
		inputTokens: base.inputTokens + extra.inputTokens,
		outputTokens: base.outputTokens + extra.outputTokens,
		...(base.cacheReadTokens !== undefined ||
		extra.cacheReadTokens !== undefined
			? {
					cacheReadTokens:
						(base.cacheReadTokens ?? 0) + (extra.cacheReadTokens ?? 0),
				}
			: {}),
		...(base.cacheWriteTokens !== undefined ||
		extra.cacheWriteTokens !== undefined
			? {
					cacheWriteTokens:
						(base.cacheWriteTokens ?? 0) + (extra.cacheWriteTokens ?? 0),
				}
			: {}),
		...(base.totalCost !== undefined || extra.totalCost !== undefined
			? { totalCost: (base.totalCost ?? 0) + (extra.totalCost ?? 0) }
			: {}),
		...(base.durationMs !== undefined || extra.durationMs !== undefined
			? { durationMs: (base.durationMs ?? 0) + (extra.durationMs ?? 0) }
			: {}),
	};
}

/**
 * Keep the earlier summaries within their size: when they have grown past
 * SUMMARY_SECTIONS_CHAR_LIMIT, the oldest ones (never the newest
 * SUMMARY_SECTIONS_KEPT_VERBATIM) are condensed into one block by a second
 * summarizer call. When that call yields nothing, the oldest sections are
 * cut to fit instead, so the summary never grows without bound.
 */
async function condenseSections(options: {
	sections: CompactionSummarySection[];
	originalRequest?: string;
	providerConfig: ProviderConfig;
	logger?: BasicLogger;
}): Promise<{
	sections: CompactionSummarySection[];
	usage?: CompactionSummarizerUsage;
	condensed: boolean;
}> {
	const { condense, keep } = selectSectionsToCondense(options.sections);
	if (condense.length === 0) {
		return { sections: options.sections, condensed: false };
	}
	const foldedMessages = condense.reduce(
		(total, section) => total + section.foldedMessages,
		0,
	);
	const span = condense[condense.length - 1].span;
	let text = "";
	let usage: CompactionSummarizerUsage | undefined;
	try {
		const result = await generateSummary({
			providerConfig: options.providerConfig,
			request: buildCondenseRequest({
				sections: condense,
				originalRequest: options.originalRequest,
			}),
			systemPrompt:
				"Condense earlier progress notes of a coding session into one shorter note. Keep verified facts, decisions and unresolved errors.",
			logger: options.logger,
		});
		text = result.text;
		usage = result.usage;
	} catch (error) {
		options.logger?.log("Condensing earlier compaction summaries failed", {
			severity: "warn",
			errorMessage: error instanceof Error ? error.message : String(error),
		});
	}
	if (!text) {
		// Cut the oldest texts so the kept-verbatim sections keep their room.
		const budget = Math.max(
			SUMMARY_CONDENSED_CHAR_LIMIT,
			SUMMARY_SECTIONS_CHAR_LIMIT - sectionsCharLength(keep),
		);
		const perSection = Math.max(200, Math.floor(budget / condense.length));
		text = condense
			.map(
				(section) =>
					`Span ${section.span}: ${truncateText(section.text.trim(), perSection)}`,
			)
			.join("\n");
	}
	const block: CompactionSummarySection = {
		span,
		foldedMessages,
		text: truncateText(text.trim(), SUMMARY_CONDENSED_CHAR_LIMIT),
		generatedAt: Date.now(),
		condensed: true,
	};
	return { sections: [block, ...keep], usage, condensed: true };
}

export async function runAgenticCompaction(options: {
	context: CoreCompactionContext;
	providerConfig: ProviderConfig;
	summarizer?: CoreCompactionSummarizerConfig;
	preserveRecentTokens: number;
	estimateMessageTokens: EstimateMessageTokens;
	logger?: BasicLogger;
}): Promise<CoreCompactionResult | undefined> {
	const messages = options.context.messages;
	if (messages.length < 2) {
		return undefined;
	}

	const cutIndex = findCutIndex(
		messages,
		options.preserveRecentTokens,
		options.estimateMessageTokens,
	);
	if (cutIndex <= 0 || cutIndex >= messages.length) {
		return undefined;
	}

	const messagesToSummarize = messages.slice(0, cutIndex);
	const latestSummaryIndex = findLatestSummaryIndex(messagesToSummarize);
	const previousSummaryMetadata =
		latestSummaryIndex >= 0
			? getCompactionSummaryMetadata(messagesToSummarize[latestSummaryIndex])
			: undefined;
	const newMessagesToFold =
		latestSummaryIndex >= 0
			? messagesToSummarize.slice(latestSummaryIndex + 1)
			: messagesToSummarize;
	if (newMessagesToFold.length === 0) {
		return undefined;
	}

	// The request the goal is written from: the newest typed prompt, or the
	// one an earlier summary pinned once that prompt was itself folded.
	const originalRequest = extractOriginalRequest(messages);
	// The prompt is repeated in the summary only once it is folded; while it
	// is in the preserved tail the model still has it verbatim.
	const requestInTail = findLastTurnStartIndex(messages) >= cutIndex;
	// Earlier progress notes are carried verbatim, not summarized again.
	let sections = carrySummarySections(previousSummaryMetadata);
	// The task list stays with the summary until the model writes a new one;
	// a failure is reported only while it is in the span being folded.
	const todo =
		extractTodoList(messagesToSummarize) ?? previousSummaryMetadata?.todo;
	const lastFailure = extractLastFailure(newMessagesToFold);
	const preProjectionFileOps = extractFileOps(messagesToSummarize);
	const summarizerProviderConfig = resolveSummarizerConfig({
		activeProviderConfig: options.providerConfig,
		summarizer: options.summarizer,
	});
	const resolvedSummarizerInputLimit = resolveProviderMaxInputTokens(
		summarizerProviderConfig,
	);
	const canUseActiveContextLimit = options.summarizer === undefined;
	const activeCompactionInputLimit = Math.max(
		options.context.budget.request.maxInputTokens,
		options.context.budget.request.triggerTokens,
		MIN_AGENTIC_SUMMARY_INPUT_TOKENS,
	);
	if (resolvedSummarizerInputLimit === undefined && !canUseActiveContextLimit) {
		options.logger?.log(
			"Agentic compaction summarizer has no known input limit; using conservative summary budget",
			{
				severity: "warn",
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
				fallbackInputLimit: MIN_AGENTIC_SUMMARY_INPUT_TOKENS,
			},
		);
	}
	const summarizerInputLimit =
		resolvedSummarizerInputLimit ??
		(canUseActiveContextLimit
			? activeCompactionInputLimit
			: MIN_AGENTIC_SUMMARY_INPUT_TOKENS);
	let condensedUsage: CompactionSummarizerUsage | undefined;
	if (sectionsCharLength(sections) > SUMMARY_SECTIONS_CHAR_LIMIT) {
		const condensed = await condenseSections({
			sections,
			originalRequest,
			providerConfig: summarizerProviderConfig,
			logger: options.logger,
		});
		sections = condensed.sections;
		condensedUsage = condensed.usage;
	}
	const previousSummary = renderSectionsForPrompt(sections);
	const summaryRequestOverheadTokens = estimateTokens(
		buildSummaryRequest({
			previousSummary,
			conversationText: "",
			fileOps: preProjectionFileOps,
			latestUserRequest: originalRequest,
			todo,
			lastFailure,
		}).length,
	);
	const availableSummaryInputTokens =
		summarizerInputLimit - summaryRequestOverheadTokens;
	if (availableSummaryInputTokens <= 0) {
		options.logger?.debug(
			"Skipped agentic compaction: summarizer budget exhausted",
			{
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
				summarizerInputLimit,
				summaryRequestOverheadTokens,
			},
		);
		return undefined;
	}
	// The summarizer is sent results cut to TOOL_RESULT_CHAR_LIMIT; cutting
	// them before the budget projection sizes the span on what is sent, so a
	// 48k-char result no longer costs its full size and gets siblings dropped.
	const summaryInputBudget = buildAgenticSummaryInputBudget({
		messages: truncateToolResultsForSummary(newMessagesToFold),
		targetTokens: availableSummaryInputTokens,
		estimateMessageTokens: options.estimateMessageTokens,
	});
	if (summaryInputBudget.status === "failed") {
		options.logger?.log(
			"Skipped agentic compaction: summary input budget failed",
			{
				severity: "warn",
				budgetWarnings: summaryInputBudget.warnings.map(
					(warning) => warning.code,
				),
				summaryInputEstimatedTokens: summaryInputBudget.estimatedTokens,
				targetTokens: availableSummaryInputTokens,
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
			},
		);
		return undefined;
	}
	// The files of the whole folded history: earlier summaries' lists, what
	// the budget projection kept, and what it dropped.
	const fileOps = mergeFileOps(
		preProjectionFileOps,
		extractFileOps(summaryInputBudget.messages),
	);
	const conversationText = serializeConversation(summaryInputBudget.messages);
	const summaryRequest = buildSummaryRequest({
		previousSummary,
		conversationText,
		fileOps,
		latestUserRequest: originalRequest,
		todo,
		lastFailure,
	});
	options.logger?.debug("Agentic compaction summarizer diagnostics", {
		messagesToSummarize: messagesToSummarize.length,
		newMessagesToFold: newMessagesToFold.length,
		preservedMessages: messages.length - cutIndex,
		earlierSections: sections.length,
		earlierSectionsChars: sectionsCharLength(sections),
		originalRequestChars: originalRequest?.length ?? 0,
		hasTodo: todo !== undefined,
		hasLastFailure: lastFailure !== undefined,
		conversationTextChars: conversationText.length,
		summaryRequestChars: summaryRequest.length,
		summaryRequestEstimatedTokens: estimateTokens(summaryRequest.length),
		newMessagesJsonChars: safeJsonSize(newMessagesToFold),
		summaryInputEstimatedTokens: summaryInputBudget.estimatedTokens,
		summaryInputActions: summaryInputBudget.actions.length,
		summaryInputWarnings: summaryInputBudget.warnings.map(
			(warning) => warning.code,
		),
		summaryRequestOverheadTokens,
		summarizerProviderId: summarizerProviderConfig.providerId,
		summarizerModelId: summarizerProviderConfig.modelId,
		summarizerInputLimit,
		maxInputTokens: options.context.budget.request.maxInputTokens,
		triggerTokens: options.context.budget.request.triggerTokens,
	});
	const summaryResult = await generateSummary({
		providerConfig: summarizerProviderConfig,
		request: summaryRequest,
		logger: options.logger,
	});
	const rawSummary = summaryResult.text;
	if (!rawSummary) {
		options.logger?.log(
			"Skipped agentic compaction: summarizer returned no summary text",
			{
				severity: "warn",
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
				summarizerMaxOutputTokens: summarizerProviderConfig.maxOutputTokens,
				reasoningChars: summaryResult.reasoningChars,
				incompleteReason: summaryResult.incompleteReason,
				likelyCause:
					summaryResult.reasoningChars > 0
						? "output_budget_consumed_by_reasoning"
						: "empty_response",
			},
		);
		return undefined;
	}

	const progress = stripHostRenderedSections(rawSummary) || rawSummary.trim();
	const tokensBefore = messages.reduce(
		(total, message) => total + options.estimateMessageTokens(message),
		0,
	);
	// The previous summary's own note joins the earlier sections; this
	// compaction's note is the newest. The section count is what the
	// condensation keeps verbatim, so its numbering follows the carried list.
	const carried: CompactionSummarySection[] = sections.map(
		(section) => section,
	);
	const newestCarried = carried.at(-1);
	if (
		newestCarried &&
		newestCarried.foldedMessages === 0 &&
		previousSummaryMetadata
	) {
		// The note carried from the previous summary stands for the messages
		// that summary folded, which it did not record; count what it replaced.
		newestCarried.foldedMessages = Math.max(
			0,
			previousSummaryMetadata.userRunSpan,
		);
	}
	const summarizerUsage = addSummarizerUsage(
		summaryResult.usage,
		condensedUsage,
	);
	const resultMessages = [
		buildSummaryMessage({
			summary: progress,
			fileOps,
			tokensBefore,
			userRunSpan: countUserRunMessages(messagesToSummarize),
			summarizerUsage,
			originalRequest,
			renderOriginalRequest: !requestInTail,
			sections: carried,
			todo,
			lastFailure,
		}),
		...messages.slice(cutIndex),
	];
	const tokensAfter = resultMessages.reduce(
		(total, message) => total + options.estimateMessageTokens(message),
		0,
	);
	options.logger?.debug("Performed agentic compaction", {
		messagesBefore: messages.length,
		messagesAfter: resultMessages.length,
		messagesSummarized: cutIndex,
		messagesPreserved: messages.length - cutIndex,
		tokensBefore,
		tokensAfter,
		earlierSections: carried.length,
		keptVerbatimSections: Math.min(
			carried.length,
			SUMMARY_SECTIONS_KEPT_VERBATIM,
		),
		maxInputTokens: options.context.budget.request.maxInputTokens,
	});
	const budgetActionCount = summaryInputBudget.actions.filter(
		(action) =>
			action.reason === "over_budget" || action.reason === "tool_pair_boundary",
	).length;
	return {
		messages: resultMessages,
		budget: {
			policyIntent: "agentic_summary",
			actionCount: budgetActionCount,
			warningCount: summaryInputBudget.warnings.length,
			liveTailHandling: summaryInputBudget.liveTailHandling,
		},
		...(summarizerUsage ? { summarizerUsage } : {}),
	};
}
