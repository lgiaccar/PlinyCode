/**
 * Per-session `SessionRuntime` orchestrator.
 *
 * Owns all cross-turn state for one logical agent session:
 *
 *   - `ConversationStore`      — message transcript + session-started gate
 *   - `MistakeTracker`         — per-session consecutive-mistake counter
 *   - `LoopDetectionTracker`   — per-session repeated-tool-call detector
 *   - `MessageBuilder`         — provider-message assembly cache
 *   - `AgentRuntimeHooks`      — runtime-native hooks from config/extensions
 *   - `RuntimeEventAdapter`    — per-run stateful `AgentRuntimeEvent`
 *                                → legacy `AgentEvent` translator
 *   - listener registry        — host subscribers see legacy `AgentEvent`s
 *   - pending tool set, abort  — per-run lifecycle housekeeping
 *
 * A fresh `AgentRuntime` is instantiated per run via
 * `createAgentRuntime(createAgentRuntimeConfig({...}))`. All
 * session-level state outlives any one `AgentRuntime`, making
 * OAuth-retry and run replay feasible.
 */

import {
	type AgentConfig,
	type AgentEvent,
	type AgentExtension,
	type AgentExtensionRegistry,
	type AgentMessage,
	type AgentResult,
	type AgentRunResult,
	type AgentRuntimeEvent,
	type AgentRuntimeHooks,
	type AgentRuntimePrepareTurnContext,
	type AgentTool,
	type BasicLogger,
	type ContributionRegistry,
	createContributionRegistry,
	type LoopDetectionConfig,
	type Message,
	type MessageWithMetadata,
	type ModelInfo,
	modelSupportsImageInput,
	modelSupportsToolCalling,
	usesImageGenerationOperation,
} from "@plinycode/shared";
import { createAgentModelFromConfig } from "../../services/llms/handler-factory";
import {
	getMessageBuilderOptionsFromEnv,
	MessageBuilder,
} from "../../session/services/message-builder";
import { dropPriorTurnReasoning } from "../../session/services/messages/prior-turn-reasoning";
import { ConversationStore } from "../../session/stores/conversation-store";
import type { AgentRuntime } from "../agent";
import { createAgentRuntime } from "../agent";
import {
	agentMessagesToMessages,
	agentMessagesToMessagesWithMetadata,
	messagesToAgentMessages,
} from "../config/agent-message-codec";
import { createAgentRuntimeConfig } from "../config/agent-runtime-config-builder";
import {
	type ConnectionUpdate,
	normalizeConnectionUpdate,
} from "../config/connection-update";
import { LoopDetectionTracker } from "../safety/loop-detection";
import { MistakeTracker } from "../safety/mistake-tracker";
import { mergeRuntimeHooks } from "./merge-runtime-hooks";
import { RuntimeEventAdapter } from "./runtime-event-adapter";
import { SessionRunRecovery } from "./session-run-recovery";
import { SessionRunTracker } from "./session-run-tracker";
import {
	buildUserTurnContent,
	filterAvailableExtensionTools,
	leveledLog,
	mergeSystemPromptRules,
	resolveRuleContent,
	tryGetModelInfo,
} from "./session-runtime-helpers";

export const SESSION_RUN_IN_PROGRESS_ERROR_CODE = "session_run_in_progress";

/**
 * A session was asked to shut down while one of its runs was still in flight and
 * no abort had been requested.
 *
 * Carries a code so callers can recognise it structurally after it crosses the
 * hub's JSON boundary, where an `Error` arrives as a bare message. Connectors use
 * it to tell "this thread's session is unusable" apart from a genuine run failure,
 * and to recover by starting a fresh session instead of wedging the thread.
 */
export class SessionRunInProgressError extends Error {
	readonly code = SESSION_RUN_IN_PROGRESS_ERROR_CODE;

	constructor(readonly agentId?: string) {
		super(
			`SessionRuntime.shutdown called while a run is in progress${
				agentId ? ` (agentId=${agentId})` : ""
			}`,
		);
		this.name = "SessionRunInProgressError";
	}
}

// =============================================================================
// Public types
// =============================================================================

/**
 * Listener invoked for every legacy `AgentEvent` produced by the
 * session runtime. Use `subscribeEvents(listener)` — it returns an
 * `unsubscribe` function.
 */
export type SessionEventListener = (event: AgentEvent) => void;

/** Subset of host-side deps needed by the session orchestrator. */
export interface SessionRuntimeOrchestratorDeps {
	readonly logger?: BasicLogger;
	/**
	 * Test hook: override the `AgentRuntime` factory. Production
	 * callers leave this undefined and get the real `createAgentRuntime`.
	 */
	readonly createAgentRuntimeImpl?: (
		config: Parameters<typeof createAgentRuntime>[0],
	) => AgentRuntime;
}

/** Connection overrides applied via `updateConnection`. */
export type ConnectionOverrides = ConnectionUpdate;

// =============================================================================
// SessionRuntime orchestrator
// =============================================================================

/**
 * Per-session orchestrator. Construct once per agent session; call
 * `run` / `continue` repeatedly. The class matches the subset of
 * runtime-facing session surface.
 */
export class SessionRuntime {
	private config: AgentConfig;
	private readonly agentId: string;
	private readonly parentAgentId?: string;
	private readonly logger?: BasicLogger;
	private readonly conversation: ConversationStore;
	private readonly mistakeTracker: MistakeTracker;
	private readonly loopTracker: LoopDetectionTracker;
	/**
	 * True when `execution.loopDetection === false` at construction
	 * time. Loop inspection is skipped entirely — the tracker still
	 * exists for API compatibility but is never fed.
	 */
	private readonly loopDetectionDisabled: boolean;
	// Host-owned provider request preparation. This runs immediately
	// before the model call so every loop iteration sees extension
	// message builders and API-safe normalization.
	readonly messageBuilder: MessageBuilder;
	/**
	 * Contribution registry that hosts extension-provided tools,
	 * commands, message builders, and providers. Lazily initialized
	 * on first run (parity with legacy `Agent.ensureExtensionsInitialized`
	 * at `packages/agents/src/agent.ts:1122-1147`).
	 */
	private readonly contributionRegistry: ContributionRegistry<
		AgentExtension,
		AgentTool,
		Message[]
	>;
	private extensionsInitialized = false;
	private readonly listeners = new Set<SessionEventListener>();
	private readonly createAgentRuntimeImpl: (
		config: Parameters<typeof createAgentRuntime>[0],
	) => AgentRuntime;

	/** Stable run id for the active run. */
	private activeRunId: string | null = null;
	/** True while a run is in flight. `canStartRun()` is the negation. */
	private running = false;
	/** True once `abort()` has been requested for the active run. */
	private abortRequested = false;
	/** Last abort reason requested for the active run. */
	private abortReason: string | undefined;
	/** Reference to the current run's `AgentRuntime` so `abort` can forward. */
	private activeRuntime: AgentRuntime | null = null;
	/** Promise returned from the current run so shutdown can await its drain. */
	private activeRunPromise: Promise<AgentResult> | null = null;

	/** Per-run `Agent → AgentEvent` adapter; `reset()` each run. */
	private readonly eventAdapter = new RuntimeEventAdapter();
	/** Session-shutdown gate — rejects late runs. */
	private shutdownCalled = false;
	/** Tool-call records, usage and mistake/loop tracking for the active run. */
	private readonly runTracker: SessionRunTracker;
	/** In-place recovery of failed runs and the deferred `run-failed` event. */
	private readonly runRecovery: SessionRunRecovery;
	private readonly handleExternalAbort = (): void => {
		this.abort(this.config.abortSignal?.reason);
	};

	constructor(config: AgentConfig, deps: SessionRuntimeOrchestratorDeps = {}) {
		this.config = config;
		this.agentId = `agent_${Date.now()}_${Math.random()
			.toString(36)
			.slice(2, 8)}`;
		this.parentAgentId = config.parentAgentId;
		this.logger = deps.logger ?? config.logger;
		this.createAgentRuntimeImpl =
			deps.createAgentRuntimeImpl ?? createAgentRuntime;

		this.conversation = new ConversationStore(config.initialMessages);
		this.messageBuilder = new MessageBuilder(getMessageBuilderOptionsFromEnv());
		this.contributionRegistry = createContributionRegistry<
			AgentExtension,
			AgentTool,
			Message[]
		>({
			extensions: config.extensions ? [...config.extensions] : [],
			setupContext: {
				session: config.extensionContext?.session,
				client: config.extensionContext?.client,
				user: config.extensionContext?.user,
				workspaceInfo: config.extensionContext?.workspace,
				automation: config.extensionContext?.automation,
				logger: config.extensionContext?.logger ?? this.logger,
			},
		});
		// Resolve + validate eagerly so `getExtensionRegistry()` is
		// callable before the first run (legacy parity with
		// `Agent` constructor at packages/agents/src/agent.ts:158-159).
		// `setup()` is deferred to `ensureExtensionsInitialized` on
		// the first run so async extension setup can't block the
		// constructor.
		this.contributionRegistry.resolve();
		this.contributionRegistry.validate();

		const maxMistakes = config.execution?.maxConsecutiveMistakes ?? 6;
		this.mistakeTracker = new MistakeTracker({
			maxConsecutiveMistakes: maxMistakes,
			onLimitReached: config.onConsecutiveMistakeLimitReached,
			emit: (event) => this.emitLegacyEvent(event),
			log: (level, message, metadata) =>
				leveledLog(this.logger, level, message, metadata),
			agentId: this.agentId,
			getConversationId: () => this.conversation.getConversationId(),
			getActiveRunId: () => this.activeRunId ?? "",
			appendRecoveryNotice: (message, _reason) => {
				this.conversation.appendMessage({
					role: "user",
					content: [{ type: "text", text: message }],
				});
			},
		});
		const loopDetectionInput = config.execution?.loopDetection;
		this.loopDetectionDisabled = loopDetectionInput === false;
		const loopConfig: Partial<LoopDetectionConfig> | undefined =
			loopDetectionInput === false || loopDetectionInput === undefined
				? undefined
				: loopDetectionInput;
		this.loopTracker = new LoopDetectionTracker(loopConfig);
		this.runTracker = new SessionRunTracker({
			conversation: this.conversation,
			mistakeTracker: this.mistakeTracker,
			loopTracker: this.loopTracker,
			loopDetectionDisabled: this.loopDetectionDisabled,
			getConfig: () => this.config,
			getActiveRuntime: () => this.activeRuntime,
		});
		this.runRecovery = new SessionRunRecovery({
			agentId: this.agentId,
			logger: this.logger,
			conversation: this.conversation,
			eventAdapter: this.eventAdapter,
			getConfig: () => this.config,
			isShutdownCalled: () => this.shutdownCalled,
			isAbortRequested: () => this.abortRequested,
			executeRunInternal: (input) => this.executeRunInternal(input),
			emitLegacyEvent: (event) => this.emitLegacyEvent(event),
		});
	}

	// -------------------------------------------------------------------
	// Accessors & state mutators
	// -------------------------------------------------------------------

	getAgentId(): string {
		return this.agentId;
	}

	getConversationId(): string {
		return this.conversation.getConversationId();
	}

	getMessages(): MessageWithMetadata[] {
		return this.conversation.getMessages();
	}

	/** True when no run is currently active and the session is not shut down. */
	canStartRun(): boolean {
		return !this.running && !this.shutdownCalled;
	}

	/**
	 * Snapshot of the contribution registry (tools, commands, and other
	 * extension contributions).
	 *
	 * Before the first run, the registry is in the `validate` phase:
	 * extensions are validated but their `setup()` callbacks have not
	 * run yet, so the snapshot only reflects eagerly-declared
	 * contributions. After the first `run()`/`continue()`, the
	 * registry is initialized (§`ensureExtensionsInitialized`), and
	 * the snapshot reflects everything extensions registered via
	 * `api.registerTool` / `registerCommand` / `registerMessageBuilder`
	 * / `registerProvider` / `registerAutomationEventType`.
	 */
	getExtensionRegistry(): AgentExtensionRegistry<AgentTool, Message[]> {
		return this.contributionRegistry.getRegistrySnapshot();
	}

	/** Append additional tools to every subsequent turn's runtime config. */
	addTools(tools: AgentTool[]): void {
		if (tools.length === 0) {
			return;
		}
		const existing = new Set(this.config.tools.map((tool) => tool.name));
		const merged = [...this.config.tools];
		for (const tool of tools) {
			if (!existing.has(tool.name)) {
				merged.push(tool);
				existing.add(tool.name);
			}
		}
		this.config = { ...this.config, tools: merged };
	}

	/** Mutate provider / reasoning fields for subsequent runs. */
	updateConnection(overrides: ConnectionOverrides): void {
		const updates = normalizeConnectionUpdate(overrides);
		const next: AgentConfig = { ...this.config };
		if (updates.providerId !== undefined) next.providerId = updates.providerId;
		if (updates.modelId !== undefined) next.modelId = updates.modelId;
		if (updates.apiKey !== undefined) next.apiKey = updates.apiKey;
		if (updates.baseUrl !== undefined) next.baseUrl = updates.baseUrl;
		if (updates.headers !== undefined) next.headers = updates.headers;
		if (updates.providerConfig !== undefined)
			next.providerConfig = updates.providerConfig;
		if (Object.hasOwn(updates, "reasoningEffort")) {
			next.reasoningEffort = updates.reasoningEffort ?? undefined;
		}
		if (Object.hasOwn(updates, "thinkingBudgetTokens")) {
			next.thinkingBudgetTokens = updates.thinkingBudgetTokens ?? undefined;
		}
		if (Object.hasOwn(updates, "thinking")) {
			next.thinking = updates.thinking ?? undefined;
			if (updates.thinking === false || updates.thinking === null) {
				next.reasoningEffort = undefined;
				next.thinkingBudgetTokens = undefined;
			}
		}
		this.config = next;
	}

	clearHistory(): void {
		this.conversation.clearHistory();
		this.resetConversationBoundaryTrackers();
	}

	restore(messages: readonly MessageWithMetadata[]): void {
		this.conversation.restore(messages);
		this.resetConversationBoundaryTrackers();
	}

	private resetConversationBoundaryTrackers(): void {
		this.messageBuilder.resetConversationState();
		this.mistakeTracker.reset();
		this.loopTracker.reset();
	}

	// -------------------------------------------------------------------
	// Event subscription (legacy shape)
	// -------------------------------------------------------------------

	/**
	 * Subscribe to **legacy** `AgentEvent`s. The session runtime
	 * translates the new `AgentRuntimeEvent` stream via
	 * `RuntimeEventAdapter` before fanout, so consumers see the
	 * pre-swap shape.
	 */
	subscribeEvents(listener: SessionEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	// -------------------------------------------------------------------
	// Abort / shutdown
	// -------------------------------------------------------------------

	notifyPendingUserMessage(): void {
		this.activeRuntime?.notifyPendingUserMessage();
	}

	abort(reason?: unknown): void {
		const message =
			typeof reason === "string"
				? reason
				: reason instanceof Error
					? reason.message
					: reason === undefined
						? undefined
						: String(reason);
		this.abortRequested = true;
		this.abortReason = message;
		if (this.activeRunPromise) {
			/**
			 * Why this exists in hub mode:
			 *
			 * The TUI and the runtime are not always in the same process. In hub
			 * mode, the visible TUI talks to a shared daemon over websocket. When the
			 * user sends a prompt, the TUI sends a "start this run" command to the
			 * daemon. The daemon starts the AgentRuntime and stores the promise for
			 * that run as `activeRunPromise`.
			 *
			 * If the user presses Escape, the TUI sends a separate "cancel the
			 * current run" command to the daemon. Cancelling a run means aborting the
			 * AgentRuntime. That is supposed to interrupt the provider stream or any
			 * other in-flight async work, and the normal way that interruption shows
			 * up in JavaScript is a rejected promise. That rejection is not a bug by
			 * itself. It is the expected result of the user saying "stop this
			 * request."
			 *
			 * The important detail is that the rejection is already handled by the
			 * code path that started the run. The original "start this run" command
			 * is still awaiting `sessionHost.send(...)`, and that await is what
			 * should eventually turn the run result or run error into a reply/event
			 * for the client.
			 *
			 * The problem we hit was a timing gap inside the daemon process. The
			 * separate cancel command can call `activeRuntime.abort(message)` while
			 * the original start command is still waiting elsewhere. The abort can
			 * make `activeRunPromise` reject immediately. If the runtime reports that
			 * rejection before the original start command observes it, Node/Bun can
			 * briefly classify it as an `unhandledRejection`.
			 *
			 * In the hub daemon, `unhandledRejection` is fatal. That is normally the
			 * right policy because real unhandled errors should not be ignored. But
			 * for this cancellation path it meant Escape could kill the daemon even
			 * though the run error was expected and the original start command was
			 * still responsible for handling it. After the daemon died, the next
			 * prompt looked like it started loading, then silently stalled because
			 * the TUI was talking to a dead runtime process.
			 *
			 * This `.catch()` is not the real application-level error handling. It is
			 * only a local safety observer attached before we trigger the abort, so
			 * the daemon does not mistake an expected cancellation rejection for a
			 * process crash. We do not replace `activeRunPromise`, await this catch,
			 * or convert the rejection into success. The original start command, and
			 * any other caller awaiting `run()` / `continue()`, still receives the
			 * same result or error it would have received without this observer.
			 */
			void this.activeRunPromise.catch(() => {});
		}
		this.activeRuntime?.abort(message);
	}

	/** Shut the session down after any active run drains. */
	async shutdown(_reason?: string, _timeoutMs?: number): Promise<void> {
		if (this.running) {
			if (!this.abortRequested || !this.activeRunPromise) {
				throw new SessionRunInProgressError(this.agentId);
			}
			await this.activeRunPromise;
		}
		if (this.shutdownCalled) {
			return;
		}
		this.shutdownCalled = true;
	}

	// -------------------------------------------------------------------
	// Run / continue
	// -------------------------------------------------------------------

	run(
		userMessage: string,
		userImages?: string[],
		userFiles?: string[],
	): Promise<AgentResult> {
		this.conversation.resetForRun();
		this.resetConversationBoundaryTrackers();
		return this.executeRun({
			userMessage,
			userImages,
			userFiles,
			isContinue: false,
		});
	}

	continue(
		userMessage?: string,
		userImages?: string[],
		userFiles?: string[],
	): Promise<AgentResult> {
		return this.executeRun({
			userMessage,
			userImages,
			userFiles,
			isContinue: true,
		});
	}

	// -------------------------------------------------------------------
	// Private implementation
	// -------------------------------------------------------------------

	private async composeSystemPrompt(
		availableToolNames: ReadonlySet<string>,
	): Promise<string> {
		const rules: string[] = [];
		for (const rule of this.contributionRegistry.getRegisteredRules()) {
			if (
				rule.whenToolAvailable &&
				!availableToolNames.has(rule.whenToolAvailable)
			) {
				continue;
			}
			const content = await resolveRuleContent(rule);
			if (content) {
				rules.push(content);
			}
		}
		return mergeSystemPromptRules(this.config.systemPrompt, rules);
	}

	private executeRun(input: {
		userMessage?: string;
		userImages?: string[];
		userFiles?: string[];
		isContinue: boolean;
	}): Promise<AgentResult> {
		let activePromise!: Promise<AgentResult>;
		activePromise = this.runRecovery
			.executeRunWithRecovery(input)
			.finally(() => {
				if (this.activeRunPromise === activePromise) {
					this.activeRunPromise = null;
				}
			});
		this.activeRunPromise = activePromise;
		return activePromise;
	}

	private async executeRunInternal(input: {
		userMessage?: string;
		userImages?: string[];
		userFiles?: string[];
		isContinue: boolean;
	}): Promise<AgentResult> {
		if (this.shutdownCalled) {
			throw new Error(
				`SessionRuntime.run called after shutdown (agentId=${this.agentId})`,
			);
		}
		if (this.running) {
			throw new Error(
				`SessionRuntime state is "running"; call canStartRun() first (agentId=${this.agentId})`,
			);
		}
		this.running = true;
		this.abortRequested = false;
		this.abortReason = undefined;
		this.activeRunId = `run_${Date.now()}_${Math.random()
			.toString(36)
			.slice(2, 8)}`;
		// Lazily initialize contribution-registry extensions on the
		// first run, before runtime construction.
		await this.ensureExtensionsInitialized();
		this.eventAdapter.reset();
		this.runTracker.reset();

		const startedAt = new Date();
		const effectiveUserMessage = input.userMessage;

		// Append the user turn (if any) to the conversation store. This
		// must happen BEFORE we snapshot `initialMessages` below so the
		// runtime sees the user message as part of its seed — we then
		// pass an empty input to `runtime.run()` so the runtime does not
		// append the message a second time (AgentRuntime.execute treats
		// a falsy input as "no additional messages", per
		// packages/agents/src/agent-runtime.ts normalizeInput path).
		if (effectiveUserMessage !== undefined) {
			const content = await buildUserTurnContent(
				effectiveUserMessage,
				input.userImages,
				input.userFiles,
				this.config.userFileContentLoader,
			);
			this.conversation.appendMessage({ role: "user", content });
		}

		// Build the AgentRuntime for this turn. A host-supplied
		// `agentModelFactory` can wrap or replace the model — e.g. to route each
		// call to a different concrete model and fail over between them. It
		// receives `createDefault` so it can build the very model this would
		// otherwise construct, optionally overriding the connection's model.
		const createDefaultAgentModel = (overrides?: {
			modelId?: string;
			providerId?: string;
		}) =>
			createAgentModelFromConfig(
				overrides?.modelId || overrides?.providerId
					? {
							...this.config,
							...(overrides.modelId ? { modelId: overrides.modelId } : {}),
							...(overrides.providerId
								? { providerId: overrides.providerId }
								: {}),
						}
					: this.config,
				this.logger,
			);
		const agentModel = this.config.agentModelFactory
			? this.config.agentModelFactory({
					config: this.config,
					createDefault: createDefaultAgentModel,
				})
			: createDefaultAgentModel();
		// Merge extension-contributed tools with the config-declared
		// tools for this turn. Extensions register tools via
		// `api.registerTool` during `setup()` — parity with legacy
		// `Agent.ensureExtensionsInitialized` at pre-Step-9 `agent.ts:1140-1146`
		// which merged `this.contributionRegistry.getRegisteredTools()`
		// into `this.config.tools`. Dedupe by name so a config tool
		// wins over a same-named extension tool (legacy behaviour:
		// `validateTools` rejects duplicates; here we prefer the
		// explicitly-declared config tool).
		const extensionToolsByName = new Map<string, AgentTool>();
		for (const tool of this.contributionRegistry.getRegisteredTools()) {
			extensionToolsByName.set(tool.name, tool);
		}
		const extensionTools = filterAvailableExtensionTools(
			[...extensionToolsByName.values()],
			this.config.toolPolicies,
		);
		const mergedToolsByName = new Map<string, AgentTool>();
		for (const tool of extensionTools) {
			mergedToolsByName.set(tool.name, tool);
		}
		for (const tool of this.config.tools) {
			mergedToolsByName.set(tool.name, tool);
		}
		const conversationId = this.conversation.getConversationId();
		const modelInfo = tryGetModelInfo(this.config);
		const dedicatedImageGeneration = usesImageGenerationOperation(
			modelInfo ?? {},
		);
		const toolCallingDisabled =
			dedicatedImageGeneration || !modelSupportsToolCalling(modelInfo ?? {});
		const availableTools = filterAvailableExtensionTools(
			Array.from(mergedToolsByName.values()),
			this.config.toolPolicies,
		);
		const tools = toolCallingDisabled ? [] : availableTools;
		const systemPrompt = await this.composeSystemPrompt(
			new Set(tools.map((tool) => tool.name)),
		);
		// Seed initialMessages with the full prior transcript (including
		// the user message we just appended) so multi-turn history is
		// preserved across runs. Fixes P1 #1: prior turns were silently
		// lost because `createAgentRuntimeConfig` received no seed and
		// `replaceMessages(runResult.messages)` downstream overwrote the
		// conversation with just the current-turn trail.
		const initialMessages = messagesToAgentMessages(
			this.conversation.getMessages(),
		);
		const runtimeConfig = createAgentRuntimeConfig({
			agentConfig: this.config,
			sessionId: this.config.sessionId,
			agentId: this.agentId,
			conversationId,
			parentAgentId: this.parentAgentId,
			model: agentModel,
			logger: this.logger,
			tools,
			toolContextMetadata: {
				modelSupportsImages: modelSupportsImageInput(modelInfo ?? {}),
				...this.config.toolContextMetadata,
			},
			hooks: this.createRuntimeHooks(),
			prepareTurn: this.createRuntimePrepareTurn(modelInfo, tools),
			initialMessages,
			consumeSystemNotice: () => this.runTracker.consumeSystemNotice(),
			completionPolicy: toolCallingDisabled ? null : undefined,
			systemPrompt,
		});
		const runtime = this.createAgentRuntimeImpl(runtimeConfig);
		this.activeRuntime = runtime;

		// Subscribe to runtime events; fan out legacy events to listeners
		// and keep private book-keeping for tool-call records / usage.
		const unsubscribe = runtime.subscribe((event: AgentRuntimeEvent) => {
			// AgentRuntime does not accept abort() until run-started. Retain an abort
			// requested during finite startup and forward it at that existing lifecycle
			// boundary instead of adding a second initialization-cancellation path.
			if (event.type === "run-started" && this.abortRequested) {
				runtime.abort(this.abortReason);
			}
			this.handleRuntimeEvent(event);
		});
		if (this.config.abortSignal) {
			if (this.config.abortSignal.aborted) {
				this.handleExternalAbort();
			} else {
				this.config.abortSignal.addEventListener(
					"abort",
					this.handleExternalAbort,
					{ once: true },
				);
			}
		}

		let runResult: AgentRunResult | undefined;
		let thrownError: Error | undefined;
		try {
			// Pass empty input so AgentRuntime does not duplicate the
			// user message we already seeded via `initialMessages`. The
			// runtime's `normalizeInput` treats `""`/`undefined` as
			// "no extra messages".
			if (input.isContinue) {
				runResult = await runtime.continue(undefined);
			} else {
				runResult = await runtime.run("");
			}
		} catch (error) {
			thrownError = error instanceof Error ? error : new Error(String(error));
		} finally {
			unsubscribe();
			this.config.abortSignal?.removeEventListener(
				"abort",
				this.handleExternalAbort,
			);
			// Drain any in-flight tracker work (mistake/loop side-effects
			// queued from handleRuntimeEvent) before we clear state so a
			// late abort can still reach the runtime if needed.
			try {
				await this.runTracker.activeTrackerWork;
			} catch (error) {
				this.logger?.error?.(
					"SessionRuntime tracker work failed during drain",
					{ agentId: this.agentId, error },
				);
			}
			this.activeRuntime = null;
			this.running = false;
			this.abortRequested = false;
			this.abortReason = undefined;
		}

		// Persist the runtime's message trail back into the conversation
		// store so later turns see assistant output. The runtime state
		// was seeded with the full transcript, so `runResult.messages`
		// IS the complete new transcript (seed + newly-produced turn).
		if (runResult && runResult.messages.length > 0) {
			const replacement = agentMessagesToMessagesWithMetadata(
				runResult.messages,
			);
			this.conversation.replaceMessages(replacement);
		}

		const endedAt = new Date();
		try {
			return this.runTracker.buildLegacyResult({
				runResult,
				thrownError,
				startedAt,
				endedAt,
			});
		} finally {
			this.activeRunId = null;
		}
	}

	/**
	 * Initialize the contribution registry once per session. Runs
	 * extension `setup()` callbacks so they can `registerTool`,
	 * `registerCommand`, `registerMessageBuilder`, and
	 * `registerProvider`. Matches legacy `Agent.ensureExtensionsInitialized`
	 * at pre-Step-9 `agent.ts:1122-1147`:
	 *
	 *   - on `hookErrorMode === "throw"`, setup failures propagate;
	 *   - otherwise setup failures emit a recoverable `error` event
	 *     via the legacy event channel and leave the registry
	 *     partially initialized.
	 *
	 * Idempotent: subsequent calls are no-ops once the registry has
	 * been activated.
	 */
	private async ensureExtensionsInitialized(): Promise<void> {
		if (this.extensionsInitialized) {
			return;
		}
		try {
			await this.contributionRegistry.initialize({
				tolerateSetupErrors: this.config.hookErrorMode !== "throw",
			});
		} catch (error) {
			if (this.config.hookErrorMode === "throw") {
				throw error;
			}
			this.emitLegacyEvent({
				type: "error",
				error: error instanceof Error ? error : new Error(String(error)),
				recoverable: true,
				iteration: 0,
			});
		}
		this.extensionsInitialized = true;
	}

	private createRuntimeHooks(): Partial<AgentRuntimeHooks> {
		const hooks = mergeRuntimeHooks([
			this.config.hooks,
			...this.contributionRegistry
				.getValidatedExtensions()
				.map((extension) => extension.hooks),
		]);
		return {
			...hooks,
			beforeModel: async (ctx) => {
				const control = await hooks.beforeModel?.(ctx);
				if (control?.stop) {
					return control;
				}
				const messages = control?.messages ?? ctx.request.messages;
				const preparedMessages =
					await this.prepareMessagesForModelRequest(messages);
				return {
					...control,
					messages: preparedMessages,
				};
			},
		};
	}

	private createRuntimePrepareTurn(
		modelInfo: ModelInfo | undefined,
		tools: AgentTool[],
	):
		| ((context: AgentRuntimePrepareTurnContext) => Promise<
				| {
						messages?: readonly AgentMessage[];
						systemPrompt?: string;
				  }
				| undefined
		  >)
		| undefined {
		const prepareTurn = this.config.prepareTurn;
		if (!prepareTurn) {
			return undefined;
		}

		return async (context) => {
			const messages = agentMessagesToMessagesWithMetadata(context.messages);
			// Size the request the way it will actually be sent (see
			// prepareMessagesForModelRequest), so earlier turns' reasoning does
			// not count towards compaction.
			const apiMessages = await this.prepareProviderMessagesForApi(
				agentMessagesToMessagesWithMetadata(
					dropPriorTurnReasoning(context.messages),
				),
			);
			const result = await prepareTurn({
				agentId: context.agentId,
				conversationId:
					context.conversationId ?? this.conversation.getConversationId(),
				parentAgentId: context.parentAgentId ?? null,
				iteration: context.iteration,
				messages,
				apiMessages,
				abortSignal: context.signal ?? new AbortController().signal,
				systemPrompt: context.systemPrompt ?? "",
				tools,
				model: {
					id: this.config.modelId,
					provider: this.config.providerId,
					info: modelInfo,
				},
				overflowRecovery: context.overflowRecovery,
				previousRequestInputTokens: context.previousRequestInputTokens,
				emitStatusNotice: context.emitStatusNotice,
			});
			if (!result) {
				return undefined;
			}
			return {
				...(result.messages
					? { messages: messagesToAgentMessages(result.messages) }
					: {}),
				...(result.systemPrompt !== undefined
					? { systemPrompt: result.systemPrompt }
					: {}),
			};
		};
	}

	private async prepareMessagesForModelRequest(
		messages: readonly AgentMessage[],
	): Promise<AgentMessage[]> {
		const providerMessages = await this.prepareProviderMessagesForApi(
			agentMessagesToMessages(dropPriorTurnReasoning(messages)),
		);
		return messagesToAgentMessages(providerMessages);
	}

	private async prepareProviderMessagesForApi(
		messages: MessageWithMetadata[],
	): Promise<MessageWithMetadata[]> {
		let providerMessages = messages;
		const messageBuilders =
			this.contributionRegistry.getRegistrySnapshot().messageBuilder;
		for (const builder of messageBuilders) {
			providerMessages = await builder.build(providerMessages);
		}
		return this.messageBuilder.buildForApi(providerMessages);
	}

	private handleRuntimeEvent(event: AgentRuntimeEvent): void {
		// Track tool-call records before translation so the timing data
		// is available to observers via `AgentResult.toolCalls`.
		this.runTracker.record(event);
		if (this.runRecovery.deferRunFailure(event)) {
			return;
		}
		for (const legacy of this.eventAdapter.translate(event)) {
			this.emitLegacyEvent(legacy);
		}
	}

	private emitLegacyEvent(event: AgentEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				this.logger?.error?.("SessionRuntime event listener threw", {
					agentId: this.agentId,
					error,
				});
			}
		}
	}
}
