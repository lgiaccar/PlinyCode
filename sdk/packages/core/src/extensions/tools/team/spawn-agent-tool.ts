/**
 * Reusable spawn_agent tool for delegating tasks to sub-agents.
 */

import {
	type AgentConfig,
	type AgentEvent,
	type AgentHooks,
	type AgentResult,
	type AgentTool,
	type AgentToolContext,
	type BasicLogger,
	createTool,
	type HookErrorMode,
	type ToolApprovalRequest,
	type ToolApprovalResult,
	type ToolPolicy,
	zodToJsonSchema,
} from "@plinycode/shared";
import { z } from "zod";
import {
	createDelegatedAgent,
	type DelegatedAgentConfigProvider,
} from "./delegated-agent";

type AgentExtension = NonNullable<AgentConfig["extensions"]>[number];
type AgentFinishReason = AgentResult["finishReason"];

/** Sub-agent runs a parent may have in flight at once; the rest wait. */
export const DEFAULT_MAX_CONCURRENT_SUB_AGENTS = 3;
/** How long one sub-agent run may take before it is stopped. */
export const DEFAULT_SUB_AGENT_TIMEOUT_MS = 20 * 60 * 1000;

export const SpawnAgentInputSchema = z.object({
	task: z
		.string()
		.describe(
			"What the sub-agent must do and what to report back. It knows nothing of this conversation: name the files or areas, the question to answer or the change to make, and the form of the report.",
		),
	instructions: z
		.string()
		.optional()
		.describe(
			"Extra instructions for the sub-agent: its role, constraints, what not to touch. Optional; the base system prompt (environment, tools, conventions) is supplied for it.",
		),
	systemPrompt: z
		.string()
		.optional()
		.describe("Older name of `instructions`; use `instructions`."),
});

export type SpawnAgentInput = z.infer<typeof SpawnAgentInputSchema>;

export interface SpawnAgentOutput {
	text: string;
	iterations: number;
	finishReason: AgentFinishReason;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		/** What the sub-agent's model calls cost, when the provider or catalog priced them. */
		totalCost?: number;
	};
}

export interface SubAgentStartContext {
	subAgentId: string;
	conversationId: string;
	parentAgentId: string;
	input: SpawnAgentInput;
}

export interface SubAgentEndContext {
	subAgentId: string;
	conversationId: string;
	parentAgentId: string;
	input: SpawnAgentInput;
	result?: SpawnAgentOutput;
	agentResult?: AgentResult;
	error?: Error;
}

/**
 * What a parent learns about a sub-agent while it runs, through
 * `context.emitUpdate`: the host's chat shows it live. Tokens and cost are
 * the sums of the sub-agent's model calls so far.
 */
export interface SubAgentProgress {
	subAgentId: string;
	toolCalls: number;
	latestToolCall?: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalCost: number;
	/** The newest model call's input size: how full the sub-agent's context is. */
	contextTokens: number;
}

export interface SpawnAgentToolConfig {
	configProvider: DelegatedAgentConfigProvider;
	defaultMaxIterations?: number;
	subAgentTools?: AgentTool[];
	createSubAgentTools?: (
		input: SpawnAgentInput,
		context: AgentToolContext,
	) => AgentTool[] | Promise<AgentTool[]>;
	onSubAgentEvent?: (event: AgentEvent) => void;
	/**
	 * Lifecycle hooks forwarded to spawned sub-agent runs.
	 */
	hooks?: AgentHooks;
	/**
	 * Extension list forwarded to spawned sub-agent runs.
	 */
	extensions?: AgentExtension[];
	/**
	 * Error handling mode for forwarded lifecycle hooks.
	 */
	hookErrorMode?: HookErrorMode;
	/**
	 * Called after a sub-agent instance is created and before it starts running.
	 * Errors are ignored so lifecycle observers cannot break task execution.
	 */
	onSubAgentStart?: (context: SubAgentStartContext) => void | Promise<void>;
	/**
	 * Called once a sub-agent run finishes (success or error).
	 * Errors are ignored so lifecycle observers cannot break task execution.
	 */
	onSubAgentEnd?: (context: SubAgentEndContext) => void | Promise<void>;
	/**
	 * Optional per-tool policy for spawned sub-agents.
	 */
	toolPolicies?: Record<string, ToolPolicy>;
	/**
	 * Optional approval callback for spawned sub-agent tool calls.
	 */
	requestToolApproval?: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
	/**
	 * The request projection (context compaction) a sub-agent run uses. Read
	 * when the sub-agent starts, since a host builds it after the tool.
	 */
	getPrepareTurn?: () => AgentConfig["prepareTurn"];
	/** Sub-agent runs allowed at once from this tool; more wait their turn. */
	maxConcurrent?: number;
	/** Longest a sub-agent run may take; it is aborted after this. */
	timeoutMs?: number;
	/**
	 * Optional logger forwarded to spawned sub-agent runs.
	 */
	logger?: BasicLogger;
}

/**
 * Forwards a sub-agent's events to the host's observer and, after each model
 * call and each tool, reports the run's progress through the parent tool
 * call's `emitUpdate`, so the host can show tokens, cost and the current
 * tool while the sub-agent runs.
 */
export function createSubAgentProgressReporter(
	context: AgentToolContext,
	onEvent?: (event: AgentEvent) => void,
): {
	onEvent: (event: AgentEvent) => void;
	bind: (subAgentId: string) => void;
	progress: () => SubAgentProgress;
} {
	const progress: SubAgentProgress = {
		subAgentId: "",
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalCost: 0,
		contextTokens: 0,
	};
	const report = () => {
		try {
			context.emitUpdate?.({ ...progress });
		} catch {
			// Progress is best-effort; the run must not fail on a host error.
		}
	};
	return {
		bind: (subAgentId) => {
			progress.subAgentId = subAgentId;
		},
		progress: () => ({ ...progress }),
		onEvent: (event) => {
			try {
				onEvent?.(event);
			} catch {
				// The host's observer must not break the run.
			}
			if (event.type === "usage") {
				const input = event.inputTokens ?? 0;
				progress.inputTokens += input;
				progress.outputTokens += event.outputTokens ?? 0;
				progress.cacheReadTokens += event.cacheReadTokens ?? 0;
				progress.cacheWriteTokens += event.cacheWriteTokens ?? 0;
				progress.totalCost += event.cost ?? 0;
				if (input > 0) {
					progress.contextTokens = input;
				}
				report();
				return;
			}
			if (event.type === "content_end" && event.contentType === "tool") {
				progress.toolCalls += 1;
				if (event.toolName) {
					progress.latestToolCall = event.toolName;
				}
				report();
			}
		},
	};
}

/** A counting semaphore: `acquire` resolves once a slot is free. */
function createSlots(max: number): { acquire: () => Promise<() => void> } {
	let running = 0;
	const waiting: Array<() => void> = [];
	const release = () => {
		running -= 1;
		const next = waiting.shift();
		if (next) {
			next();
		}
	};
	return {
		acquire: () =>
			new Promise<() => void>((resolve) => {
				const take = () => {
					running += 1;
					resolve(release);
				};
				if (running < max) {
					take();
				} else {
					waiting.push(take);
				}
			}),
	};
}

/**
 * Runs the sub-agent under the parent's abort signal and a time limit. The
 * child gets a signal of its own, so a timeout stops it the way a cancel
 * would, and the parent's signal still cancels it.
 */
function deriveRunSignal(
	parent: AbortSignal | undefined,
	timeoutMs: number | undefined,
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
	const controller = new AbortController();
	let timedOut = false;
	const onParentAbort = () => controller.abort();
	if (parent?.aborted) {
		controller.abort();
	} else {
		parent?.addEventListener("abort", onParentAbort, { once: true });
	}
	const timer =
		timeoutMs !== undefined && timeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					controller.abort();
				}, timeoutMs)
			: undefined;
	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		dispose: () => {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			parent?.removeEventListener("abort", onParentAbort);
		},
	};
}

/** The instructions a parent wrote for its sub-agent, under either input name. */
export function resolveSpawnAgentInstructions(input: SpawnAgentInput): string {
	return input.instructions?.trim() || input.systemPrompt?.trim() || "";
}

export function spawnAgentOutputFromResult(
	result: AgentResult,
	progress?: SubAgentProgress,
): SpawnAgentOutput {
	const usage = result.usage as AgentResult["usage"] & {
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		totalCost?: number;
	};
	// The run's own figures first; the progress sums only when they say
	// something, so a run that reported nothing keeps a plain output.
	const positive = (value: number | undefined) =>
		value !== undefined && value > 0 ? value : undefined;
	const cacheReadTokens =
		usage.cacheReadTokens ?? positive(progress?.cacheReadTokens);
	const cacheWriteTokens =
		usage.cacheWriteTokens ?? positive(progress?.cacheWriteTokens);
	const totalCost = usage.totalCost ?? positive(progress?.totalCost);
	return {
		text: result.text,
		iterations: result.iterations,
		finishReason: result.finishReason,
		usage: {
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
			...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
			...(totalCost !== undefined ? { totalCost } : {}),
		},
	};
}

/**
 * Create a spawn_agent tool that can run a delegated task with a focused sub-agent.
 */
export function createSpawnAgentTool(
	config: SpawnAgentToolConfig,
): AgentTool<SpawnAgentInput, SpawnAgentOutput> {
	const slots = createSlots(
		config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SUB_AGENTS,
	);
	const timeoutMs = config.timeoutMs ?? DEFAULT_SUB_AGENT_TIMEOUT_MS;
	return createTool<SpawnAgentInput, SpawnAgentOutput>({
		name: "spawn_agent",
		executionMode: "parallel",
		description:
			"Delegate a self-contained piece of work to a sub-agent that runs in its own context and returns only its final report. " +
			"Use it for exploration across many files, for independent subtasks that can run in parallel (several calls in one reply), " +
			"and for anything whose intermediate output you do not need in your own context. " +
			"The sub-agent starts with no memory of this conversation: put everything it needs in `task`, and ask for a concise report. " +
			"It has the same working directory and tools as you, except that it cannot ask the user, save memories or delegate further. " +
			"Not for one-file reads or single commands: do those yourself.",
		inputSchema: zodToJsonSchema(SpawnAgentInputSchema),
		execute: async (input, context) => {
			const tools = config.createSubAgentTools
				? await config.createSubAgentTools(input, context)
				: (config.subAgentTools ?? []);
			const reporter = createSubAgentProgressReporter(
				context,
				config.onSubAgentEvent,
			);
			const release = await slots.acquire();
			const run = deriveRunSignal(context.signal, timeoutMs);
			try {
				const subAgent = createDelegatedAgent({
					kind: "subagent",
					prompt: resolveSpawnAgentInstructions(input),
					configProvider: config.configProvider,
					tools,
					maxIterations: config.defaultMaxIterations,
					parentAgentId: context.agentId,
					abortSignal: run.signal,
					onEvent: reporter.onEvent,
					hookErrorMode: config.hookErrorMode,
					toolPolicies: config.toolPolicies,
					requestToolApproval: config.requestToolApproval,
					prepareTurn: config.getPrepareTurn?.(),
				});
				const subAgentId = subAgent.getAgentId();
				const conversationId = subAgent.getConversationId();
				const parentAgentId = context.agentId;
				reporter.bind(subAgentId);
				if (config.onSubAgentStart) {
					try {
						await config.onSubAgentStart({
							subAgentId,
							conversationId,
							parentAgentId,
							input,
						});
					} catch {
						// Best-effort observer callback.
					}
				}
				try {
					const result = await subAgent.run(input.task);
					if (run.timedOut()) {
						throw new Error(
							`The sub-agent was stopped after ${Math.round(timeoutMs / 60000)} minutes without finishing.`,
						);
					}
					const output = spawnAgentOutputFromResult(
						result,
						reporter.progress(),
					);
					if (config.onSubAgentEnd) {
						try {
							await config.onSubAgentEnd({
								subAgentId,
								conversationId,
								parentAgentId,
								input,
								result: output,
								agentResult: result,
							});
						} catch {
							// Best-effort observer callback.
						}
					}
					return output;
				} catch (error) {
					if (config.onSubAgentEnd) {
						try {
							await config.onSubAgentEnd({
								subAgentId,
								conversationId,
								parentAgentId,
								input,
								error:
									error instanceof Error ? error : new Error(String(error)),
							});
						} catch {
							// Best-effort observer callback.
						}
					}
					throw error;
				}
			} finally {
				run.dispose();
				release();
			}
		},
		timeoutMs,
		retryable: false,
	});
}
