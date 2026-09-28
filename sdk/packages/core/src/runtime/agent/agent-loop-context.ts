import type {
	AgentMessage,
	AgentModelOutputLimit,
	AgentRuntimeEvent,
	AgentRuntimeHooks,
	AgentRuntimeStateSnapshot,
	AgentStopControl,
	AgentTool,
	AgentRuntimeConfig as BaseAgentRuntimeConfig,
	ProviderErrorClass,
} from "@plinycode/shared";
import { cloneUsage, DEFAULT_USAGE } from "./agent-messages";

export interface HookBag {
	beforeRun: NonNullable<AgentRuntimeHooks["beforeRun"]>[];
	afterRun: NonNullable<AgentRuntimeHooks["afterRun"]>[];
	beforeModel: NonNullable<AgentRuntimeHooks["beforeModel"]>[];
	afterModel: NonNullable<AgentRuntimeHooks["afterModel"]>[];
	beforeTool: NonNullable<AgentRuntimeHooks["beforeTool"]>[];
	afterTool: NonNullable<AgentRuntimeHooks["afterTool"]>[];
	onEvent: NonNullable<AgentRuntimeHooks["onEvent"]>[];
}

export type ResolvedAgentRuntimeConfig = Required<
	Pick<BaseAgentRuntimeConfig, "toolExecution">
> &
	BaseAgentRuntimeConfig;

export function createAgentRuntimeState() {
	return {
		agentId: "",
		agentRole: undefined as string | undefined,
		parentAgentId: undefined as string | null | undefined,
		runId: undefined as string | undefined,
		status: "idle" as AgentRuntimeStateSnapshot["status"],
		iteration: 0,
		messages: [] as AgentMessage[],
		pendingToolCalls: [] as string[],
		usage: cloneUsage(DEFAULT_USAGE),
		lastError: undefined as string | undefined,
		lastErrorClass: undefined as ProviderErrorClass | undefined,
		/** Provider-reported input tokens for the most recent request this run. */
		lastRequestInputTokens: 0,
		/** Output-token cap reported on the most recent model finish event. */
		lastOutputLimit: undefined as AgentModelOutputLimit | undefined,
		/**
		 * Whether the last provider failure was transient and worth retrying,
		 * carried from the model boundary via `errorRetryable` on the `finish`
		 * event (the AI SDK's typed `isRetryable` flag). Undefined when no such
		 * signal was provided, in which case the agent loop classifies from the
		 * flattened `lastError` message instead.
		 */
		lastErrorRetryable: undefined as boolean | undefined,
	};
}

export type AgentRuntimeState = ReturnType<typeof createAgentRuntimeState>;

/**
 * The parts of an `AgentRuntime` that the model-turn, retry and
 * tool-execution modules read and update. `AgentRuntime` builds one view over
 * its own fields, so these modules always see the runtime's current values.
 */
export interface AgentLoopContext {
	readonly config: ResolvedAgentRuntimeConfig;
	readonly state: AgentRuntimeState;
	// biome-ignore lint/suspicious/noExplicitAny: tool input/output types vary per tool
	readonly tools: Map<string, AgentTool<any, any>>;
	readonly hooks: HookBag;
	pendingHookContexts: string[];
	overflowRecoveryAttempted: boolean;
	readonly abortController: AbortController | undefined;
	modelSteerController: AbortController | undefined;
	userMessageController: AbortController;
	snapshot(): AgentRuntimeStateSnapshot;
	emit(event: AgentRuntimeEvent): Promise<void>;
	applyStopControl(control: AgentStopControl | undefined): void;
	throwIfAborted(): void;
	normalizeAbortError(): Error;
}
