import { isAbsolute, resolve } from "node:path";
import type * as LlmsProviders from "@plinycode/llms";
import {
	type AgentResult,
	isLikelyAuthError,
	normalizeUserInput,
} from "@plinycode/shared";
import { isOAuthProvider } from "../../../auth/provider-auth-registry";
import { resolveWorkspacePath } from "../../../services/config";
import { withLatestAssistantTurnMetadata } from "../../../services/session-data";
import {
	accumulateUsageTotals,
	createInitialAccumulatedUsage,
	sumUsageTotals,
} from "../../../services/usage";
import { enrichPromptWithMentions } from "../../../services/workspace";
import {
	buildTeamRunContinuationPrompt,
	formatModePrompt,
	hasPendingTeamRunWork,
	shouldAutoContinueTeamRuns,
	waitForTeamRunUpdates,
} from "../../../session/team";
import type { SessionStatus } from "../../../types/common";
import type { ActiveSession, PreparedTurnInput } from "../../../types/session";
import type { SessionRunOptions } from "../../orchestration/session-runtime-orchestrator";
import type { PendingPromptsController } from "../../turn-queue/pending-prompt-service";
import type {
	SendSessionInput,
	SessionAccumulatedUsage,
} from "../runtime-host";
import type { AgentEventBridge } from "./agent-event-bridge";

/** The parts of `LocalRuntimeHost` that turn execution uses. */
export interface TurnExecutionHost {
	readonly usageBySession: Map<string, SessionAccumulatedUsage>;
	readonly aggregateUsageBySession: Map<string, SessionAccumulatedUsage>;
	readonly eventBridge: AgentEventBridge;
	readonly pendingPromptsController: PendingPromptsController;
	ensureSessionPersisted(session: ActiveSession): Promise<void>;
	refreshActiveSessionGitMetadata(session: ActiveSession): Promise<void>;
	syncOAuthCredentials(
		session: ActiveSession,
		options?: { forceRefresh?: boolean },
	): Promise<void>;
	markTurnRunning(session: ActiveSession): Promise<void>;
	markTurnIdle(session: ActiveSession): Promise<void>;
	persistSessionMetadata(
		sessionId: string,
		resolveMetadata: (
			current: Record<string, unknown> | undefined,
		) => Record<string, unknown> | undefined,
	): Promise<void>;
	invoke<T>(method: string, ...args: unknown[]): Promise<T>;
	invokeOptionalValue<T = unknown>(
		method: string,
		...args: unknown[]
	): Promise<T | undefined>;
}

export async function executeTurn(
	host: TurnExecutionHost,
	session: ActiveSession,
	input: {
		prompt: string;
		mode?: SendSessionInput["mode"];
		userImages?: string[];
		userFiles?: string[];
		offTheRecord?: boolean;
	},
): Promise<AgentResult> {
	// An off-the-record question is answered under ask mode's rules, so its
	// <user_input> tag says so whatever the session's mode is.
	const preparedInput = await prepareTurnInput(
		session,
		input.offTheRecord ? { ...input, mode: "ask" } : input,
	);
	const prompt = preparedInput.prompt.trim();
	const images = preparedInput?.userImages?.length;
	const files = preparedInput?.userFiles?.length;
	if (!prompt && !images && !files) throw new Error("prompt cannot be empty");

	if (!session.artifacts && !session.pendingPrompt) {
		session.pendingPrompt = prompt;
	}
	await host.ensureSessionPersisted(session);
	// A seeded session (fork, checkpoint restore, missing-session
	// recovery) materializes at start, before any prompt exists, so its
	// row is created promptless. Backfill it with the first user prompt,
	// which restores the behavior rows had when materialization happened
	// here: the persistence service derives the title from this prompt
	// when the session is untitled, and leaves any user-set title alone.
	if (!session.pendingPrompt) {
		session.pendingPrompt = prompt;
		try {
			await host.invokeOptionalValue("updateSession", {
				sessionId: session.sessionId,
				prompt,
			});
		} catch (error) {
			session.config.logger?.log?.("Failed to backfill seeded session prompt", {
				severity: "warn",
				sessionId: session.sessionId,
				error,
			});
		}
	}
	await host.refreshActiveSessionGitMetadata(session);
	await host.syncOAuthCredentials(session);
	await host.markTurnRunning(session);

	try {
		let result = await executeAgentTurn(
			host,
			session,
			prompt,
			preparedInput.userImages,
			preparedInput.userFiles,
			input.offTheRecord ? { offTheRecord: true } : undefined,
		);

		while (shouldAutoContinueTeamRuns(session, result.finishReason)) {
			const updates = await waitForTeamRunUpdates(session);
			if (updates.length === 0) break;
			const continuationPrompt = buildTeamRunContinuationPrompt(
				session,
				updates,
			);
			result = await executeAgentTurn(host, session, continuationPrompt);
		}

		return result;
	} finally {
		await host.refreshActiveSessionGitMetadata(session);
	}
}

export async function completeInteractiveTurn(
	host: TurnExecutionHost,
	session: ActiveSession,
	finishReason: AgentResult["finishReason"],
): Promise<void> {
	if (hasPendingTeamRunWork(session)) return;
	session.lastInteractiveTurnFinishReason = finishReason;
	await host.markTurnIdle(session);
	session.aborting = false;
}

export function resolveInteractiveStopStatus(
	session: ActiveSession,
): SessionStatus {
	const finishReason = session.lastInteractiveTurnFinishReason;
	if (!finishReason) return "cancelled";

	switch (finishReason) {
		case "completed":
			return "completed";
		case "error":
			return "failed";
		case "aborted":
		case "max_iterations":
		case "mistake_limit":
			return "cancelled";
	}

	const _exhaustive: never = finishReason;
	return _exhaustive;
}

export function resolveInteractiveStopExitCode(session: ActiveSession): number {
	return session.lastInteractiveTurnFinishReason === "error" ? 1 : 0;
}

export async function completeAbortedInteractiveTurn(
	host: TurnExecutionHost,
	session: ActiveSession,
): Promise<AgentResult> {
	const endedAt = new Date();
	const messages = session.agent.getMessages();
	const usage = createInitialAccumulatedUsage();
	session.persistedMessages = messages;
	session.started = session.started || messages.length > 0;
	// Flush the transcript now: persistence otherwise lags at
	// assistant-message/turn boundaries, so without this an aborted turn
	// (including the user's prompt) exists only in memory. If the session
	// later has to be rebuilt from disk (hub restart, session eviction),
	// the recovery would silently drop the aborted exchange — or, for a
	// session seeded with in-memory history, the entire conversation.
	if (messages.length > 0) {
		try {
			await host.ensureSessionPersisted(session);
			await host.invoke<void>(
				"persistSessionMessages",
				session.sessionId,
				messages,
				session.config.systemPrompt,
			);
		} catch (error) {
			session.config.logger?.error?.(
				"Failed to persist session messages after abort",
				{ sessionId: session.sessionId, error },
			);
		}
	}
	host.eventBridge.dispatchAgentEvent(session.sessionId, session.config, {
		type: "done",
		reason: "aborted",
		text: "",
		iterations: 0,
		usage,
	});
	await completeInteractiveTurn(host, session, "aborted");
	// The abort is fully settled (aborting flag reset above), so prompts
	// the user queued behind the stopped turn can run now. This mirrors
	// the drain in runTurn() for turns that resolve with an "aborted"
	// finish; this path handles turns that end by throwing instead.
	queueMicrotask(() => {
		void host.pendingPromptsController.drain(session.sessionId);
	});
	return {
		text: "",
		usage,
		messages,
		toolCalls: [],
		iterations: 0,
		finishReason: "aborted",
		model: {
			id: session.config.modelId,
			provider: session.config.providerId,
		},
		startedAt: endedAt,
		endedAt,
		durationMs: 0,
	};
}

async function executeAgentTurn(
	host: TurnExecutionHost,
	session: ActiveSession,
	prompt: string,
	userImages?: string[],
	userFiles?: string[],
	runOptions?: SessionRunOptions,
): Promise<AgentResult> {
	const shouldContinue =
		session.started || session.agent.getMessages().length > 0;
	const baselineMessages =
		session.persistedMessages ?? session.agent.getMessages();
	const usageBaseline =
		host.usageBySession.get(session.sessionId) ??
		createInitialAccumulatedUsage();
	const aggregateUsageBaseline =
		host.aggregateUsageBySession.get(session.sessionId) ?? usageBaseline;
	session.turnUsageBaseline = usageBaseline;
	session.turnAggregateUsageBaseline = aggregateUsageBaseline;
	session.turnPrimaryUsage = createInitialAccumulatedUsage();
	session.turnUsageByAgent = new Map<string, SessionAccumulatedUsage>();

	try {
		// Options are passed only when there are any, so an ordinary turn calls
		// run/continue exactly as before they existed.
		const optionArgs: [SessionRunOptions] | [] = runOptions ? [runOptions] : [];
		const runFn = shouldContinue
			? () =>
					session.agent.continue(prompt, userImages, userFiles, ...optionArgs)
			: () => session.agent.run(prompt, userImages, userFiles, ...optionArgs);
		const result = await runWithAuthRetry(
			host,
			session,
			runFn,
			baselineMessages,
		);

		session.started = true;
		const persistedMessages = withLatestAssistantTurnMetadata(
			result.messages,
			result,
			baselineMessages,
		);
		session.persistedMessages = persistedMessages;
		const teammateTurnUsage = sumUsageTotals(
			session.turnUsageByAgent?.values() ?? [],
		);
		const accumulatedUsage = accumulateUsageTotals(usageBaseline, result.usage);
		const aggregateTurnUsage = accumulateUsageTotals(
			accumulateUsageTotals(createInitialAccumulatedUsage(), result.usage),
			teammateTurnUsage,
		);
		const aggregateUsage = accumulateUsageTotals(
			aggregateUsageBaseline,
			aggregateTurnUsage,
		);
		host.usageBySession.set(session.sessionId, accumulatedUsage);
		host.aggregateUsageBySession.set(session.sessionId, aggregateUsage);
		await host.persistSessionMetadata(session.sessionId, (current) => ({
			...(current ?? {}),
			totalCost: accumulatedUsage.totalCost,
			aggregatedAgentsCost: aggregateUsage.totalCost,
			usage: accumulatedUsage,
			aggregateUsage,
		}));
		await host.invoke<void>(
			"persistSessionMessages",
			session.sessionId,
			persistedMessages,
			session.config.systemPrompt,
		);
		return result;
	} catch (error) {
		try {
			await host.invoke<void>(
				"persistSessionMessages",
				session.sessionId,
				session.agent.getMessages(),
				session.config.systemPrompt,
			);
		} catch (persistError) {
			// Never let a failed transcript flush mask the error that
			// actually killed the turn; that one is what callers must see.
			session.config.logger?.error?.(
				"Failed to persist session messages after turn error",
				{ sessionId: session.sessionId, error: persistError },
			);
		}
		throw error;
	} finally {
		session.turnUsageBaseline = undefined;
		session.turnAggregateUsageBaseline = undefined;
		session.turnPrimaryUsage = undefined;
		session.turnUsageByAgent = undefined;
	}
}

async function prepareTurnInput(
	session: ActiveSession,
	input: {
		prompt: string;
		mode?: SendSessionInput["mode"];
		userImages?: string[];
		userFiles?: string[];
	},
): Promise<PreparedTurnInput> {
	const mentionBaseDir = resolveWorkspacePath(session.config);
	const normalizedPrompt = normalizeUserInput(input.prompt).trim();
	if (!normalizedPrompt) {
		return {
			prompt: "",
			userImages: input.userImages,
			userFiles: resolveAbsoluteFilePaths(session.config.cwd, input.userFiles),
		};
	}

	const enriched = await enrichPromptWithMentions(
		normalizedPrompt,
		mentionBaseDir,
	);

	const prompt = formatModePrompt(
		enriched.prompt,
		input.mode ?? session.config.mode,
	);
	const explicitUserFiles = resolveAbsoluteFilePaths(
		session.config.cwd,
		input.userFiles,
	);
	const mentionedFiles = resolveAbsoluteFilePaths(
		mentionBaseDir,
		enriched.matchedFiles,
	);
	const mergedUserFiles = Array.from(
		new Set([...explicitUserFiles, ...mentionedFiles]),
	);

	return {
		prompt,
		userImages: input.userImages,
		userFiles: mergedUserFiles.length > 0 ? mergedUserFiles : undefined,
	};
}

async function runWithAuthRetry(
	host: TurnExecutionHost,
	session: ActiveSession,
	run: () => Promise<AgentResult>,
	baselineMessages: LlmsProviders.Message[],
): Promise<AgentResult> {
	try {
		return await run();
	} catch (error) {
		if (
			!isOAuthProvider(session.config.providerId) ||
			!isLikelyAuthError(error)
		) {
			throw error;
		}
		await host.syncOAuthCredentials(session, { forceRefresh: true });
		session.agent.restore(baselineMessages);
		return run();
	}
}

function resolveAbsoluteFilePaths(cwd: string, paths?: string[]): string[] {
	if (!paths || paths.length === 0) return [];
	const resolved = paths
		.map((p) => p.trim())
		.filter((p) => p.length > 0)
		.map((p) => (isAbsolute(p) ? p : resolve(cwd, p)));
	return Array.from(new Set(resolved));
}
