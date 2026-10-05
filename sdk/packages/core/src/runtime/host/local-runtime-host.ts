import { homedir } from "node:os";
import { join } from "node:path";
import type * as LlmsProviders from "@plinycode/llms";
import {
	type AgentConfig,
	type AgentEvent,
	type AgentResult,
	type BasicLogger,
	type CompletionGuard,
	createSessionId,
} from "@plinycode/shared";
import { setHomeDirIfUnset } from "@plinycode/shared/storage";
import { isOAuthProvider } from "../../auth/provider-auth-registry";
import {
	createCompactionStateAwarePrepareTurn,
	createContextCompactionPrepareTurn,
	createImportedHistoryCompactionPrepareTurn,
} from "../../extensions/context/compaction";
import type { ToolExecutors } from "../../extensions/tools";
import { RunCommandExecutionController } from "../../extensions/tools";
import { cleanupStaleDetachedCommandLogs } from "../../extensions/tools/executors/bash";
import type { TeamEvent } from "../../extensions/tools/team";
import type { HookEventPayload } from "../../hooks";
import { resolveWorkspacePath } from "../../services/config";
import { resolveCoreDistinctId } from "../../services/distinct-id";
import { prepareLocalRuntimeBootstrap } from "../../services/local-runtime-bootstrap";
import { nowIso } from "../../services/session-artifacts";
import { toSessionRecord } from "../../services/session-data";
import { ProviderSettingsManager } from "../../services/storage/provider-settings-manager";
import {
	createInitialAccumulatedUsage,
	summarizeUsageFromMessages,
} from "../../services/usage";
import { resolveStartSessionWorkspace } from "../../services/workspace/chat-workspace";
import {
	type GitWorkspaceState,
	hasCurrentSessionGitMetadata,
	readGitWorkspaceState,
	withSessionGitMetadata,
} from "../../services/workspace/workspace-manifest";
import {
	readSessionHistoryOriginMetadata,
	withSessionHistoryOriginMetadata,
} from "../../session/history-origin";
import type { SessionCompactionState } from "../../session/models/session-compaction";
import {
	type SessionManifest,
	SessionManifestSchema,
} from "../../session/models/session-manifest";
import type { SessionRow } from "../../session/models/session-row";
import type { RootSessionArtifacts } from "../../session/services/session-service";
import { createCoreSessionSnapshot } from "../../session/session-snapshot";
import { SessionVersioningService } from "../../session/session-versioning-service";
import {
	formatModePrompt,
	hasPendingTeamRunWork,
	notifyTeamRunWaiters,
} from "../../session/team";
import {
	isNonTerminalSessionStatus,
	SessionSource,
	type SessionStatus,
} from "../../types/common";
import type { CoreSessionConfig } from "../../types/config";
import type { CoreSessionEvent } from "../../types/events";
import type { ActiveSession } from "../../types/session";
import type { SessionRecord } from "../../types/sessions";
import type { RuntimeCapabilities } from "../capabilities";
import { normalizeRuntimeCapabilities } from "../capabilities";
import { normalizeConnectionUpdate } from "../config/connection-update";
import { DefaultRuntimeBuilder } from "../orchestration/runtime-builder";
import {
	OAuthReauthRequiredError,
	type RuntimeOAuthResolution,
	RuntimeOAuthTokenManager,
} from "../orchestration/runtime-oauth-token-manager";
import type { RuntimeBuilder } from "../orchestration/session-runtime";
import { SessionRuntime } from "../orchestration/session-runtime-orchestrator";
import { PendingPromptsController } from "../turn-queue/pending-prompt-service";
import { manifestToSessionRecord } from "./history";
import { AgentEventBridge } from "./local/agent-event-bridge";
import { SessionCompactionStateStore } from "./local/compaction-state-store";
import {
	type SessionBackend,
	toActiveSessionRecord,
} from "./local/session-record";
import {
	invokeBackend,
	invokeBackendOptional,
	invokeBackendOptionalValue,
} from "./local/session-service-invoker";
import {
	createSessionSpawnTool,
	createSessionSubAgentLifecycleCallbacks,
} from "./local/spawn-tool";
import {
	completeAbortedInteractiveTurn,
	completeInteractiveTurn,
	executeTurn,
	resolveInteractiveStopExitCode,
	resolveInteractiveStopStatus,
	type TurnExecutionHost,
} from "./local/turn-execution";
import { seedAggregateUsageFromArtifacts } from "./local/usage-aggregation";
import { loadUserFileContent } from "./local/user-files";
import type {
	ListSessionsOptions,
	PendingPromptsServiceApi,
	ResolvedStartSessionInput,
	RestoreSessionInput,
	RestoreSessionResult,
	RuntimeHost,
	RuntimeHostSubscribeOptions,
	SendSessionInput,
	SessionAccumulatedUsage,
	SessionConnectionUpdate,
	SessionUsageSummary,
	StartSessionInput,
	StartSessionResult,
} from "./runtime-host";
import { SessionNotFoundError } from "./runtime-host";
import {
	cloneAccumulatedUsage,
	RuntimeHostEventBus,
	readPersistedMessagesFile,
	replaySubagentHookEvent,
} from "./runtime-host-support";

const MAX_SCAN_LIMIT = 5000;

// Detached-log retention timers are process-local and intentionally unref'd.
// Recover once for every process that owns a LocalRuntimeHost so embedders get
// the same restart cleanup guarantee as the Hub daemon. A failed scan is
// cleared so a later host construction can retry it.
let detachedCommandLogRecovery: Promise<void> | undefined;

function recoverDetachedCommandLogsOnce(logger?: BasicLogger): void {
	if (detachedCommandLogRecovery) return;
	detachedCommandLogRecovery = cleanupStaleDetachedCommandLogs()
		.then(() => undefined)
		.catch((error) => {
			detachedCommandLogRecovery = undefined;
			logger?.error?.("Detached command log recovery failed", { error });
		});
}

/**
 * Add a host-supplied completion guard to the policy core built. Core's own
 * guard (team obligations) is asked first, so its reminder wins.
 */
export function withHostCompletionGuard(
	policy: AgentConfig["completionPolicy"],
	hostGuard: CompletionGuard | undefined,
): AgentConfig["completionPolicy"] {
	if (!hostGuard) {
		return policy;
	}
	const coreGuard = policy?.completionGuard;
	return {
		...policy,
		completionGuard: async (context) =>
			(await coreGuard?.(context)) ?? (await hostGuard(context)),
	};
}

export interface LocalRuntimeHostOptions {
	distinctId?: string;
	sessionService: SessionBackend;
	runtimeBuilder?: RuntimeBuilder;
	createAgent?: (config: AgentConfig) => SessionRuntime;
	capabilities?: RuntimeCapabilities;
	toolPolicies?: AgentConfig["toolPolicies"];
	providerSettingsManager?: ProviderSettingsManager;
	oauthTokenManager?: RuntimeOAuthTokenManager;
	logger?: BasicLogger;
	/**
	 * Default custom `fetch` implementation threaded into every
	 * `ProviderConfig.fetch` built during local session bootstrap. Used by
	 * the AI gateway providers when issuing HTTP requests.
	 */
	fetch?: typeof fetch;
}

export class LocalRuntimeHost implements RuntimeHost {
	public readonly runtimeAddress = undefined;
	public readonly pendingPrompts: PendingPromptsServiceApi;
	private readonly sessionService: SessionBackend;
	private readonly runtimeBuilder: RuntimeBuilder;
	private readonly createAgentInstance: (config: AgentConfig) => SessionRuntime;
	private readonly toolExecutors?: Partial<ToolExecutors>;
	private readonly defaultCapabilities?: RuntimeCapabilities;
	private readonly defaultToolPolicies?: AgentConfig["toolPolicies"];
	private readonly providerSettingsManager: ProviderSettingsManager;
	private readonly oauthTokenManager: RuntimeOAuthTokenManager;
	private readonly distinctId: string;
	private readonly defaultLogger?: BasicLogger;
	private readonly defaultFetch?: typeof fetch;
	private readonly events = new RuntimeHostEventBus();
	private readonly sessions = new Map<string, ActiveSession>();
	// Serializes manifest read-modify-writes per session; see mutateSessionManifest.
	private readonly manifestMutationQueues = new Map<string, Promise<void>>();
	private readonly usageBySession = new Map<string, SessionAccumulatedUsage>();
	private readonly aggregateUsageBySession = new Map<
		string,
		SessionAccumulatedUsage
	>();
	private readonly pendingPromptsController: PendingPromptsController;
	private readonly eventBridge: AgentEventBridge;
	private readonly sessionVersioning = new SessionVersioningService();
	private readonly runCommandExecutionController =
		new RunCommandExecutionController();
	private readonly compactionStateStore: SessionCompactionStateStore;
	/** The view of this host that the turn-execution functions use. */
	private readonly turnHost: TurnExecutionHost;

	constructor(options: LocalRuntimeHostOptions) {
		const homeDir = homedir();
		if (homeDir) setHomeDirIfUnset(homeDir);
		const distinctId = resolveCoreDistinctId(options.distinctId);
		this.distinctId = distinctId;
		this.sessionService = options.sessionService;
		this.runtimeBuilder = options.runtimeBuilder ?? new DefaultRuntimeBuilder();
		this.createAgentInstance =
			options.createAgent ?? ((config) => new SessionRuntime(config));
		this.defaultCapabilities = normalizeRuntimeCapabilities(
			options.capabilities,
		);
		this.toolExecutors = this.defaultCapabilities?.toolExecutors;
		this.defaultToolPolicies = options.toolPolicies;
		this.providerSettingsManager =
			options.providerSettingsManager ?? new ProviderSettingsManager();
		this.oauthTokenManager =
			options.oauthTokenManager ??
			new RuntimeOAuthTokenManager({
				providerSettingsManager: this.providerSettingsManager,
			});
		this.defaultLogger = options.logger;
		this.defaultFetch = options.fetch;
		recoverDetachedCommandLogsOnce(this.defaultLogger);

		this.pendingPromptsController = new PendingPromptsController({
			getSession: (sid) => this.sessions.get(sid),
			emit: (event) => this.emit(event),
			send: (input) => this.runTurn(input),
		});
		this.pendingPrompts = {
			steerFirst: async (input) =>
				this.pendingPromptsController.steerFirst(input.sessionId),
			list: async (input) =>
				this.pendingPromptsController.list(input.sessionId),
			update: async (input) => this.pendingPromptsController.update(input),
			delete: async (input) => this.pendingPromptsController.delete(input),
		};
		this.eventBridge = new AgentEventBridge({
			getSession: (sid) => this.sessions.get(sid),
			usageBySession: this.usageBySession,
			aggregateUsageBySession: this.aggregateUsageBySession,
			emit: (event) => this.emit(event),
			persistMessages: (sid, messages, systemPrompt) => {
				// Fire-and-forget: an unobserved rejection here would surface as
				// an unhandledRejection, which is fatal in the hub daemon.
				void this.invoke<void>(
					"persistSessionMessages",
					sid,
					messages,
					systemPrompt,
				).catch((error) => {
					const session = this.sessions.get(sid);
					const logger = session?.config.logger ?? this.defaultLogger;
					logger?.error?.(
						"Failed to persist session messages from agent event",
						{
							sessionId: sid,
							error,
						},
					);
				});
			},
			enqueuePendingPrompt: (sid, entry) =>
				this.pendingPromptsController.enqueue(sid, entry),
			invokeBackendOptional: (method, ...args) =>
				this.invokeOptional(method, ...args),
		});
		this.compactionStateStore = new SessionCompactionStateStore({
			sessions: this.sessions,
			getSession: (sessionId) => this.getSession(sessionId),
			readSessionMessages: (sessionId) => this.readSessionMessages(sessionId),
			invoke: <T>(method: string, ...args: unknown[]) =>
				this.invoke<T>(method, ...args),
			invokeOptionalValue: <T>(method: string, ...args: unknown[]) =>
				this.invokeOptionalValue<T>(method, ...args),
		});
		this.turnHost = {
			usageBySession: this.usageBySession,
			aggregateUsageBySession: this.aggregateUsageBySession,
			eventBridge: this.eventBridge,
			pendingPromptsController: this.pendingPromptsController,
			ensureSessionPersisted: (session) => this.ensureSessionPersisted(session),
			refreshActiveSessionGitMetadata: (session) =>
				this.refreshActiveSessionGitMetadata(session),
			syncOAuthCredentials: (session, options) =>
				this.syncOAuthCredentials(session, options),
			markTurnRunning: (session) => this.markTurnRunning(session),
			markTurnIdle: (session) => this.markTurnIdle(session),
			persistSessionMetadata: (sessionId, resolveMetadata) =>
				this.persistSessionMetadata(sessionId, resolveMetadata),
			invoke: <T>(method: string, ...args: unknown[]) =>
				this.invoke<T>(method, ...args),
			invokeOptionalValue: <T>(method: string, ...args: unknown[]) =>
				this.invokeOptionalValue<T>(method, ...args),
		};
	}

	private async applyInitialOAuthCredentials(
		input: ResolvedStartSessionInput,
	): Promise<ResolvedStartSessionInput> {
		if (input.config.apiKey?.trim()) {
			return input;
		}

		const resolved = await this.oauthTokenManager.resolveProviderApiKey({
			providerId: input.config.providerId,
		});
		if (!resolved?.apiKey) {
			return input;
		}

		return {
			...input,
			config: {
				...input.config,
				apiKey: resolved.apiKey,
			},
		};
	}

	// ── Public API ──────────────────────────────────────────────────────

	async startSession(input: StartSessionInput): Promise<StartSessionResult> {
		const requestedSessionId = input.config.sessionId?.trim() ?? "";
		const sessionId = requestedSessionId || createSessionId();
		const isReadOnlyResumeStart =
			requestedSessionId.length > 0 &&
			(input.initialMessages?.length ?? 0) > 0 &&
			!input.prompt?.trim();
		const hasRequestedWorkspace = Boolean(
			input.config.cwd?.trim() || input.config.workspaceRoot?.trim(),
		);
		const existingResumeManifest =
			isReadOnlyResumeStart && !hasRequestedWorkspace
				? await this.invokeOptionalValue<SessionManifest>(
						"readSessionManifest",
						sessionId,
					)
				: undefined;
		const config = existingResumeManifest
			? {
					...input.config,
					cwd: existingResumeManifest.cwd,
					workspaceRoot: existingResumeManifest.workspace_root,
				}
			: await resolveStartSessionWorkspace(input.config);
		return await this.startResolvedSession(
			{ ...input, config },
			sessionId,
			requestedSessionId.length > 0,
			existingResumeManifest,
		);
	}

	private async startResolvedSession(
		input: ResolvedStartSessionInput,
		sessionId: string,
		wasSessionIdRequested: boolean,
		existingResumeManifest?: SessionManifest,
	): Promise<StartSessionResult> {
		const source = input.source ?? SessionSource.CLI;
		const startedAt = nowIso();
		const startInput: ResolvedStartSessionInput =
			await this.applyInitialOAuthCredentials(input);
		const initialMessages = startInput.initialMessages ?? [];
		const initialUsage =
			initialMessages.length > 0
				? summarizeUsageFromMessages(initialMessages)
				: createInitialAccumulatedUsage();

		const sessionsDir =
			((await this.invokeOptionalValue("ensureSessionsDir")) as
				| string
				| undefined) ?? "";
		if (!sessionsDir) {
			throw new Error(
				"session service method not available: ensureSessionsDir",
			);
		}

		const sessionDir = join(sessionsDir, sessionId);
		const messagesPath = join(sessionDir, `${sessionId}.messages.json`);
		const manifestPath = join(sessionDir, `${sessionId}.json`);
		const workspacePath = resolveWorkspacePath(input.config);

		// An interactive session started without a prompt has no turn in
		// flight (turns arrive through separate send calls), so it must not
		// report "running" — a created-but-never-prompted session otherwise
		// stayed "running" forever, wedging clients that gate workspace
		// operations (e.g. checkpoint restore) on active turns. One-shot
		// starts still run their prompt inside start() and begin "running".
		const startsWithoutTurn =
			input.interactive === true && !startInput.prompt?.trim();
		let manifest = SessionManifestSchema.parse({
			version: 1,
			session_id: sessionId,
			source,
			pid: process.pid,
			started_at: startedAt,
			status: startsWithoutTurn ? "idle" : "running",
			interactive: input.interactive === true,
			provider: startInput.config.providerId,
			model: startInput.config.modelId,
			cwd: startInput.config.cwd,
			workspace_root: workspacePath,
			team_name: startInput.config.teamName,
			enable_tools: startInput.config.enableTools,
			enable_spawn: startInput.config.enableSpawnAgent,
			enable_teams: startInput.config.enableAgentTeams,
			prompt: startInput.prompt?.trim() || undefined,
			messages_path: messagesPath,
		});
		let resumedArtifacts: RootSessionArtifacts | undefined;
		let resumedCompactionState: SessionCompactionState | undefined;
		const isReadOnlyResumeStart =
			wasSessionIdRequested &&
			initialMessages.length > 0 &&
			!startInput.prompt?.trim();
		if (isReadOnlyResumeStart) {
			const existingManifest =
				existingResumeManifest ??
				(await this.invokeOptionalValue<SessionManifest>(
					"readSessionManifest",
					sessionId,
				));
			if (existingManifest) {
				manifest = existingManifest;
				resumedArtifacts = {
					manifestPath,
					messagesPath: existingManifest.messages_path || messagesPath,
					compactionPath: existingManifest.compaction_path,
					manifest: existingManifest,
				};
				resumedCompactionState =
					await this.invokeOptionalValue<SessionCompactionState>(
						"readSessionCompactionState",
						sessionId,
					);
			}
		}
		const initialAggregateUsage = await seedAggregateUsageFromArtifacts({
			initialUsage,
			sessionDir,
			rootMessagesPath: resumedArtifacts?.messagesPath ?? messagesPath,
			manifest,
		});
		this.usageBySession.set(sessionId, initialUsage);
		this.aggregateUsageBySession.set(sessionId, initialAggregateUsage);

		const capabilities = normalizeRuntimeCapabilities(
			this.defaultCapabilities,
			input.capabilities,
		);
		const sessionToolExecutors =
			capabilities?.toolExecutors ?? this.toolExecutors;
		const inputLocalConfig = input.localRuntime as
			| Partial<CoreSessionConfig>
			| undefined;
		const pluginEventFallbackLogger =
			inputLocalConfig?.extensionContext?.logger ?? inputLocalConfig?.logger;
		const pluginEventFallbackAutomation =
			inputLocalConfig?.extensionContext?.automation;
		let bootstrap!: Awaited<ReturnType<typeof prepareLocalRuntimeBootstrap>>;
		const subAgentDeps = {
			getSession: (sid: string) => this.sessions.get(sid),
			onAgentEvent: (
				rootSessionId: string,
				config: CoreSessionConfig,
				event: AgentEvent,
			) => this.eventBridge.dispatchAgentEvent(rootSessionId, config, event),
			invokeBackendOptional: (method: string, ...args: unknown[]) =>
				this.invokeOptional(method, ...args),
		};
		// A resumed session keeps the provenance it was initiated with
		// (automation trigger, import source): the start input's metadata
		// always carries a default "user" origin, which would otherwise
		// overwrite the stored one on the next metadata write. An explicit
		// mode on the start input replaces the stored origin entirely.
		const resumedOrigin = readSessionHistoryOriginMetadata(
			resumedArtifacts?.manifest.metadata,
		);
		const sessionOrigin = readSessionHistoryOriginMetadata(
			withSessionHistoryOriginMetadata(startInput.sessionMetadata, {
				mode: startInput.mode ?? resumedOrigin?.mode,
				trigger: startInput.mode ? undefined : resumedOrigin?.trigger,
			}),
		);
		bootstrap = await prepareLocalRuntimeBootstrap({
			input: startInput,
			localRuntime: input.localRuntime,
			sessionId,
			providerSettingsManager: this.providerSettingsManager,
			defaultLogger: this.defaultLogger,
			defaultCapabilities: capabilities,
			defaultToolPolicies: this.defaultToolPolicies,
			defaultFetch: this.defaultFetch,
			onPluginEvent: (event) => {
				if (event.name === "plugin_log") {
					this.eventBridge.handlePluginLog(
						sessionId,
						event.payload,
						pluginEventFallbackLogger,
					);
					return;
				}
				void this.eventBridge.handlePluginEvent(
					sessionId,
					event,
					pluginEventFallbackAutomation,
				);
			},
			onTeamEvent: (event: TeamEvent) => {
				void this.eventBridge.handleTeamEvent(sessionId, event);
				bootstrap.config.onTeamEvent?.(event);
			},
			createSpawnTool: () =>
				createSessionSpawnTool(
					subAgentDeps,
					bootstrap.config,
					sessionId,
					sessionToolExecutors,
				),
			createSubAgentLifecycleCallbacks: (config) =>
				createSessionSubAgentLifecycleCallbacks(
					subAgentDeps,
					config,
					sessionId,
				),
			readSessionMetadata: async () =>
				(await this.getSession(sessionId))?.metadata as
					| Record<string, unknown>
					| undefined,
			writeSessionMetadata: async (metadata) => {
				await this.persistSessionMetadata(sessionId, () => metadata);
			},
		});
		const initialSessionMetadata = withSessionHistoryOriginMetadata(
			withSessionGitMetadata(
				{
					...(resumedArtifacts?.manifest.metadata ?? {}),
					...(startInput.sessionMetadata ?? {}),
				},
				bootstrap.gitState,
			),
			{
				mode: sessionOrigin?.mode,
				trigger: sessionOrigin?.trigger,
				version: bootstrap.config.extensionContext?.client?.version,
			},
		);
		if (!resumedArtifacts) manifest.metadata = initialSessionMetadata;
		const runtime = await this.runtimeBuilder.build({
			...bootstrap.runtimeBuilderInput,
			distinctId: this.distinctId,
			runCommandExecutionController: this.runCommandExecutionController,
		});
		const configWithProvider = bootstrap.config;
		const providerConfig = bootstrap.providerConfig;
		if (runtime.teamRuntime && !configWithProvider.teamName?.trim()) {
			configWithProvider.teamName = runtime.teamRuntime.getTeamName();
		}

		// Auth-retry hook for every agent in the session (lead, teammates,
		// subagents): refresh OAuth credentials and propagate the new key to
		// all connections, then let the runtime retry the failed run. Without
		// this, a token that expires while the lead is blocked (e.g. in
		// team_await_runs) kills teammate runs with a raw provider 401.
		const onAuthError = async (): Promise<boolean> => {
			const liveSession = this.sessions.get(sessionId);
			if (!liveSession || !isOAuthProvider(liveSession.config.providerId)) {
				return false;
			}
			try {
				await this.syncOAuthCredentials(liveSession, { forceRefresh: true });
				return true;
			} catch {
				return false;
			}
		};
		runtime.delegatedAgentConfigProvider?.updateConnectionDefaults({
			onAuthError,
			// Subagents inherit the lead's routing and recovery behavior.
			agentModelFactory: configWithProvider.agentModelFactory,
			onRunError: configWithProvider.onRunError,
		});

		const tools = [...runtime.tools, ...(configWithProvider.extraTools ?? [])];
		const extensions = runtime.extensions ?? bootstrap.extensions;
		const explicitInitialCompactionState = startInput.initialCompactionState;
		let activeSessionRef: ActiveSession | undefined;
		const rawInitialCompactionState =
			explicitInitialCompactionState ?? resumedCompactionState;
		const autoCompact = createContextCompactionPrepareTurn(configWithProvider);
		// Resuming an imported session summarizes the foreign transcript before
		// the model sees it. The summary persists to the compaction sidecar and
		// the policy stands down once that sidecar projects, so it applies once
		// per session and again only if the sidecar has gone stale.
		const importedFrom = isReadOnlyResumeStart
			? readImportedFromTool(manifest.metadata)
			: undefined;
		const compact = importedFrom
			? createImportedHistoryCompactionPrepareTurn({
					config: configWithProvider,
					importedFrom,
					next: autoCompact,
				})
			: autoCompact;
		// A compaction sidecar must keep projecting into the working context even
		// when auto-compaction is disabled (`compact` undefined): manual /compact
		// persists a sidecar and promises the next turn will use it. The
		// state-aware prepareTurn handles `compact: undefined` by projecting the
		// existing state without re-compacting, and no-ops when no state exists.
		const initialCompactionState = rawInitialCompactionState
			? {
					...rawInitialCompactionState,
					conversation_id:
						rawInitialCompactionState.conversation_id?.trim() || sessionId,
				}
			: undefined;
		const prepareTurn = createCompactionStateAwarePrepareTurn({
			compact,
			getState: () => activeSessionRef?.compactionState,
			saveState: async (state, sourceMessages) => {
				const activeSession = activeSessionRef;
				if (!activeSession) return;
				const stateForSession = {
					...state,
					conversation_id: activeSession.sessionId,
				};
				try {
					// Validate against the exact messages the state's hash was
					// computed from. Mid-turn, `agent.getMessages()` (the
					// conversation store) can legally differ from the runtime's
					// working transcript, so validating against the store would
					// spuriously reject the write.
					const result =
						await this.compactionStateStore.persistActiveSessionCompactionState(
							activeSession,
							stateForSession,
							sourceMessages,
						);
					if (!result.updated) {
						configWithProvider.logger?.debug?.(
							"Skipped stale session compaction state",
							{
								sessionId: activeSession.sessionId,
								sourceMessageCount: stateForSession.source_message_count,
							},
						);
					}
				} catch (error) {
					configWithProvider.logger?.error?.(
						"Failed to persist session compaction state",
						{ sessionId: activeSession.sessionId, error },
					);
				}
			},
		});

		const agentConfig = {
			distinctId: this.distinctId,
			sessionId,
			providerId: providerConfig.providerId,
			modelId: providerConfig.modelId,
			apiKey: providerConfig.apiKey,
			baseUrl: providerConfig.baseUrl,
			headers: providerConfig.headers,
			onAuthError,
			// Host-supplied model routing / run recovery. Threaded explicitly so
			// a host can route each call across models and fail over in place.
			agentModelFactory: configWithProvider.agentModelFactory,
			onRunError: configWithProvider.onRunError,
			knownModels: providerConfig.knownModels,
			providerConfig,
			thinking: configWithProvider.thinking,
			reasoningEffort:
				configWithProvider.reasoningEffort ?? providerConfig.reasoningEffort,
			thinkingBudgetTokens: configWithProvider.thinkingBudgetTokens,
			maxTokensPerTurn: configWithProvider.maxTokensPerTurn,
			temperature: configWithProvider.temperature,
			systemPrompt: configWithProvider.systemPrompt,
			maxIterations: configWithProvider.maxIterations,
			execution: configWithProvider.execution,
			prepareTurn,
			tools,
			modelTools: runtime.modelTools,
			hooks: bootstrap.hooks,
			extensions,
			hookErrorMode: configWithProvider.hookErrorMode,
			initialMessages: bootstrap.effectiveInput.initialMessages,
			userFileContentLoader: loadUserFileContent,
			toolPolicies: bootstrap.toolPolicies,
			requestToolApproval: bootstrap.requestToolApproval
				? async (request) => {
						const requestToolApproval = bootstrap.requestToolApproval;
						const liveSession = this.sessions.get(sessionId);
						if (liveSession) {
							await this.markTurnPending(liveSession);
						}
						try {
							if (!requestToolApproval) {
								return {
									approved: false,
									reason: "Tool approval callback is not configured.",
								};
							}
							return await requestToolApproval(request);
						} finally {
							const currentSession = this.sessions.get(sessionId);
							if (currentSession?.status === "pending") {
								await this.markTurnRunning(currentSession);
							}
						}
					}
				: undefined,
			onConsecutiveMistakeLimitReached:
				configWithProvider.onConsecutiveMistakeLimitReached,
			completionPolicy: withHostCompletionGuard(
				runtime.completionPolicy,
				configWithProvider.completionGuard,
			),
			consumePendingUserMessage: () => {
				const entry = this.pendingPromptsController.consumeSteer(sessionId);
				return entry
					? formatModePrompt(
							entry.prompt,
							entry.mode ?? configWithProvider.mode,
						)
					: undefined;
			},
			logger: runtime.logger ?? configWithProvider.logger,
			extensionContext: configWithProvider.extensionContext,
			onEvent: (event: AgentEvent) =>
				this.eventBridge.dispatchAgentEvent(
					sessionId,
					configWithProvider,
					event,
				),
		} as AgentConfig;
		agentConfig.hooks = {
			...agentConfig.hooks,
			onEvent: async (event) => {
				await bootstrap.hooks?.onEvent?.(event);
				if (event.type !== "assistant-message") return;
				const liveSession = this.sessions.get(sessionId);
				if (!liveSession) return;
				const messages = liveSession.agent.getMessages();
				try {
					await this.invoke<void>(
						"persistSessionMessages",
						sessionId,
						messages,
						configWithProvider.systemPrompt,
					);
				} catch (error) {
					configWithProvider.logger?.error?.(
						"Failed to persist session messages after assistant response",
						{ sessionId, error },
					);
				}
			},
		};
		const agent = this.createAgentInstance(agentConfig);
		if (agentConfig.onEvent) {
			agent.subscribeEvents(agentConfig.onEvent);
		}
		runtime.registerLeadAgent?.(agent);

		const active: ActiveSession = {
			sessionId,
			config: configWithProvider,
			sessionMetadata: initialSessionMetadata,
			...(resumedArtifacts ? { artifacts: resumedArtifacts } : {}),
			source,
			startedAt: resumedArtifacts?.manifest.started_at ?? startedAt,
			updatedAt:
				resumedArtifacts?.manifest.ended_at ??
				resumedArtifacts?.manifest.started_at ??
				startedAt,
			pendingPrompt: manifest.prompt,
			runtime,
			agent,
			started: false,
			status:
				resumedArtifacts?.manifest.status ??
				(startsWithoutTurn ? "idle" : "running"),
			aborting: false,
			interactive: input.interactive === true,
			persistedMessages: initialMessages,
			compactionState: initialCompactionState,
			activeTeamRunIds: new Set<string>(),
			pendingTeamRunUpdates: [],
			teamRunWaiters: [],
			pendingPrompts: [],
			drainingPendingPrompts: false,
			pluginSandboxShutdown: bootstrap.pluginSandboxShutdown,
			lastInteractiveTurnFinishReason: undefined,
		};
		activeSessionRef = active;
		if (
			active.compactionState &&
			!this.compactionStateStore.isCompactionStateForSession(
				active.sessionId,
				active.compactionState,
				active,
			)
		) {
			active.config.logger?.log?.(
				"Ignoring session compaction state for a different conversation",
				{
					severity: "warn",
					sessionId: active.sessionId,
					conversationId: active.compactionState.conversation_id,
				},
			);
			active.compactionState = undefined;
		}
		this.sessions.set(sessionId, active);
		if (resumedArtifacts) {
			await this.refreshActiveSessionGitMetadata(active, bootstrap.gitState);
		}
		// Sessions seeded with history (mode-switch restarts, forks, missing-
		// session recovery) must be durable immediately. Lazy persistence
		// otherwise keeps the seed memory-only until the first completed turn,
		// so losing the resident session before then (hub restart/crash) would
		// rebuild it from an empty disk file and silently wipe the
		// conversation. Brand-new empty sessions stay lazy.
		if (initialMessages.length > 0 && !resumedArtifacts) {
			try {
				await this.ensureSessionPersisted(active);
				await this.invoke<void>(
					"persistSessionMessages",
					sessionId,
					initialMessages,
					active.config.systemPrompt,
				);
			} catch (error) {
				active.config.logger?.error?.(
					"Failed to persist seeded session messages at start",
					{ sessionId, error },
				);
			}
		}
		this.emitStatus(sessionId, active.status);

		let result: AgentResult | undefined;
		try {
			if (startInput.prompt?.trim()) {
				result = await executeTurn(this.turnHost, active, {
					prompt: startInput.prompt,
					userImages: startInput.userImages,
					userFiles: startInput.userFiles,
				});
				if (!active.interactive) {
					await this.finalizeSingleRun(active, result.finishReason);
				} else {
					await completeInteractiveTurn(
						this.turnHost,
						active,
						result.finishReason,
					);
				}
			}
		} catch (error) {
			if (active.interactive && active.aborting) {
				result = await completeAbortedInteractiveTurn(this.turnHost, active);
			} else {
				try {
					await this.failSession(active);
				} catch (cleanupError) {
					// Never let cleanup failures mask the error that actually
					// killed the turn; that one is what callers must see.
					active.config.logger?.error?.("Session failure cleanup threw", {
						sessionId: active.sessionId,
						error: cleanupError,
					});
				}
				throw error;
			}
		}

		return {
			sessionId,
			manifest,
			manifestPath,
			messagesPath,
			result,
		};
	}

	async restoreSession(
		input: RestoreSessionInput,
	): Promise<RestoreSessionResult> {
		return this.sessionVersioning.restoreCheckpoint({
			...input,
			getSession: (sessionId) => this.getSession(sessionId),
			readMessages: (sessionId) => this.readSessionMessages(sessionId),
			buildStartInput: (context, startInput) => {
				const sessionMetadata = context.restoredCheckpointMetadata
					? {
							...(startInput.sessionMetadata ?? {}),
							checkpoint: context.restoredCheckpointMetadata,
						}
					: startInput.sessionMetadata;
				return {
					...startInput,
					...(sessionMetadata ? { sessionMetadata } : {}),
					initialMessages: context.initialMessages,
				};
			},
			startSession: (startInput) => this.startSession(startInput),
			getStartedSessionId: (startResult) => startResult.sessionId,
			cleanupStartedSession: async (startResult) => {
				if (!(await this.deleteSession(startResult.sessionId))) {
					throw new Error(
						`Failed to clean up restored session ${startResult.sessionId}`,
					);
				}
			},
			readRestoredSession: (sessionId) => this.getSession(sessionId),
		});
	}

	async runTurn(input: SendSessionInput): Promise<AgentResult | undefined> {
		const session = this.getSessionOrThrow(input.sessionId);
		const canStartRun = session.agent.canStartRun();
		const delivery =
			input.delivery ??
			(session.interactive && !canStartRun ? ("queue" as const) : undefined);
		if (delivery === "queue" || delivery === "steer") {
			this.pendingPromptsController.enqueue(input.sessionId, {
				prompt: input.prompt,
				mode: input.mode,
				delivery,
				userImages: input.userImages,
				userFiles: input.userFiles,
				...(input.offTheRecord ? { offTheRecord: true } : {}),
			});
			return undefined;
		}
		try {
			const result = await executeTurn(this.turnHost, session, {
				prompt: input.prompt,
				mode: input.mode,
				userImages: input.userImages,
				userFiles: input.userFiles,
				offTheRecord: input.offTheRecord,
			});
			if (!session.interactive) {
				await this.finalizeSingleRun(session, result.finishReason);
			} else {
				await completeInteractiveTurn(
					this.turnHost,
					session,
					result.finishReason,
				);
			}
			// Drain after "aborted" finishes too: both internal stops (loop
			// detector / mistake limit) and user-initiated aborts keep the
			// queue intact, so without a drain here the user-queued prompts
			// would be stranded forever. "error" finishes deliberately do NOT
			// drain — auto-running queued prompts into a failing provider
			// would consume them; they stay queued and drain on the next
			// enqueue/update or successful turn.
			if (result.finishReason !== "error") {
				queueMicrotask(() => {
					void this.pendingPromptsController.drain(input.sessionId);
				});
			}
			return result;
		} catch (error) {
			if (session.interactive && session.aborting) {
				return await completeAbortedInteractiveTurn(this.turnHost, session);
			}
			await this.failSession(session);
			throw error;
		}
	}

	async getAccumulatedUsage(
		sessionId: string,
	): Promise<SessionUsageSummary | undefined> {
		const usage = cloneAccumulatedUsage(this.usageBySession.get(sessionId));
		const aggregateUsage = cloneAccumulatedUsage(
			this.aggregateUsageBySession.get(sessionId),
		);
		return usage || aggregateUsage ? { usage, aggregateUsage } : undefined;
	}

	async abort(sessionId: string, reason?: unknown): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		// Aborting a user-initiated turn leaves pendingPrompts untouched:
		// clearing here would silently destroy prompts the user already typed
		// and queued — they drain once the abort completes. Aborting a
		// queue-initiated turn (drainingPendingPrompts) is the opposite
		// gesture: the user is cancelling the queued work itself, so drop the
		// remainder — otherwise every Escape would consume one queued prompt
		// and start a fresh provider call, and the session could never be
		// brought to a full stop.
		session.aborting = true;
		if (session.drainingPendingPrompts) {
			this.pendingPromptsController.discardQueue(session);
		}
		const teamRuntime = session.runtime.teamRuntime;
		try {
			teamRuntime?.cancelOutstandingWork(reason);
		} finally {
			if (teamRuntime) {
				session.activeTeamRunIds.clear();
				session.pendingTeamRunUpdates.length = 0;
				notifyTeamRunWaiters(session);
			}
			session.agent.abort(reason);
		}
	}

	async proceedWhileRunning(
		sessionId: string,
		toolCallId?: string,
	): Promise<number> {
		return this.runCommandExecutionController.proceedWhileRunning(
			sessionId,
			toolCallId,
		);
	}

	async stopSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		if (session.interactive && !isNonTerminalSessionStatus(session.status)) {
			await this.releaseSessionRuntime(session, "session_stop");
			return;
		}
		if (session.interactive && session.agent.canStartRun()) {
			await this.shutdownSession(session, {
				status: resolveInteractiveStopStatus(session),
				exitCode: resolveInteractiveStopExitCode(session),
				shutdownReason: "session_stop",
				endReason: "stopped",
			});
			return;
		}
		// Abort the agent first if it's running, so shutdown can proceed
		session.aborting = true;
		session.agent.abort(new Error("session_stop"));
		await this.shutdownSession(session, {
			status: "cancelled",
			exitCode: 0,
			shutdownReason: "session_stop",
			endReason: "stopped",
		});
	}

	async dispose(reason = "session_manager_dispose"): Promise<void> {
		const sessions = [...this.sessions.values()];
		if (sessions.length === 0) return;
		await Promise.allSettled(
			sessions.map((session) =>
				session.interactive && !isNonTerminalSessionStatus(session.status)
					? this.releaseSessionRuntime(session, reason)
					: session.interactive && session.agent.canStartRun()
						? this.shutdownSession(session, {
								status: resolveInteractiveStopStatus(session),
								exitCode: resolveInteractiveStopExitCode(session),
								shutdownReason: reason,
								endReason: "disposed",
							})
						: this.shutdownSession(session, {
								status: "cancelled",
								exitCode: 0,
								shutdownReason: reason,
								endReason: "disposed",
							}),
			),
		);
		this.usageBySession.clear();
		this.aggregateUsageBySession.clear();
	}

	async getSession(sessionId: string): Promise<SessionRecord | undefined> {
		const active = this.sessions.get(sessionId);
		if (active) {
			return toActiveSessionRecord(active);
		}
		const target = sessionId.trim();
		if (!target) return undefined;
		const row = await this.getRow(target);
		if (row) return toSessionRecord(row);
		const manifest = await this.readManifest(target);
		return manifest ? manifestToSessionRecord(manifest) : undefined;
	}

	async listSessions(
		limit = 200,
		options: ListSessionsOptions = {},
	): Promise<SessionRecord[]> {
		const rows = await this.listRows(limit, options);
		const persisted = rows.map(toSessionRecord);
		const seen = new Set(persisted.map((row) => row.sessionId));
		for (const active of this.sessions.values()) {
			if (seen.has(active.sessionId)) {
				continue;
			}
			persisted.unshift(toActiveSessionRecord(active));
		}
		return persisted.slice(0, limit);
	}

	async deleteSession(sessionId: string): Promise<boolean> {
		if (this.sessions.has(sessionId)) {
			await this.stopSession(sessionId);
		}
		const result = await this.invoke<{ deleted: boolean }>(
			"deleteSession",
			sessionId,
		);
		if (result.deleted) {
			this.usageBySession.delete(sessionId);
			this.aggregateUsageBySession.delete(sessionId);
		}
		return result.deleted;
	}

	async updateSession(
		sessionId: string,
		updates: {
			prompt?: string | null;
			metadata?: Record<string, unknown> | null;
			title?: string | null;
		},
	): Promise<{ updated: boolean }> {
		const result = await this.invokeOptionalValue<{ updated?: boolean }>(
			"updateSession",
			{
				sessionId,
				prompt: updates.prompt,
				metadata: updates.metadata,
				title: updates.title,
			},
		);
		const updated = result?.updated === true;
		const active = this.sessions.get(sessionId);
		if (
			updated &&
			active &&
			(updates.metadata !== undefined ||
				updates.title !== undefined ||
				updates.prompt !== undefined)
		) {
			// A loaded session answers getSession() from memory and writes that
			// copy back at turn boundaries. Take the stored metadata into it, or
			// host edits made mid-session (a conversation's budget, its title)
			// are invisible to readers and later overwritten.
			const manifest = await this.invokeOptionalValue<SessionManifest>(
				"readSessionManifest",
				sessionId,
			);
			const metadata =
				(manifest?.metadata as Record<string, unknown> | undefined) ??
				updates.metadata ??
				undefined;
			active.sessionMetadata = metadata;
			if (active.artifacts) {
				active.artifacts.manifest.metadata = metadata;
			}
		}
		return { updated };
	}

	async updateSessionCompactionState(
		sessionId: string,
		state: SessionCompactionState,
	): Promise<{ updated: boolean }> {
		return this.compactionStateStore.updateSessionCompactionState(
			sessionId,
			state,
		);
	}

	async readSessionCompactionState(
		sessionId: string,
	): Promise<SessionCompactionState | undefined> {
		return this.compactionStateStore.readSessionCompactionState(sessionId);
	}

	async readLiveSessionMessages(
		sessionId: string,
	): Promise<LlmsProviders.MessageWithMetadata[]> {
		const target = sessionId.trim();
		if (!target) return [];
		// Resident sessions are authoritative: disk persistence lags at
		// assistant-message/turn boundaries and abort() does not flush, so a
		// mid-turn read of the persisted file would silently drop the
		// in-flight exchange (e.g. hosts that abort a turn and immediately
		// re-read messages to rebuild the session for a plan/act mode switch).
		const live = this.sessions.get(target);
		if (live) {
			const messages = live.agent.getMessages();
			if (messages.length > 0) {
				return messages;
			}
		}
		return this.readSessionMessages(target);
	}

	async readSessionMessages(
		sessionId: string,
	): Promise<LlmsProviders.MessageWithMetadata[]> {
		const target = sessionId.trim();
		if (!target) return [];
		const row = await this.getRow(target);
		if (row?.messagesPath) {
			return readPersistedMessagesFile(row.messagesPath);
		}
		const manifest = await this.readManifest(target);
		return readPersistedMessagesFile(manifest?.messages_path);
	}

	async dispatchHookEvent(payload: HookEventPayload): Promise<void> {
		await replaySubagentHookEvent(payload, {
			queueSpawnRequest: (event: HookEventPayload) =>
				this.invokeOptional("queueSpawnRequest", event),
			upsertSubagentSessionFromHook: (event: HookEventPayload) =>
				this.invokeOptionalValue<string | undefined>(
					"upsertSubagentSessionFromHook",
					event,
				),
			appendSubagentHookAudit: (sessionId: string, event: HookEventPayload) =>
				this.invokeOptional("appendSubagentHookAudit", sessionId, event),
			applySubagentStatus: (sessionId: string, event: HookEventPayload) =>
				this.invokeOptional("applySubagentStatus", sessionId, event),
		});
	}

	subscribe(
		listener: (event: CoreSessionEvent) => void,
		options?: RuntimeHostSubscribeOptions,
	): () => void {
		return this.events.subscribe(listener, options);
	}

	async updateSessionModel(sessionId: string, modelId: string): Promise<void> {
		await this.updateSessionConnection(sessionId, { modelId });
	}

	async updateSessionConnection(
		sessionId: string,
		rawUpdates: SessionConnectionUpdate,
	): Promise<void> {
		const updates = normalizeConnectionUpdate(rawUpdates);
		const session = this.getSessionOrThrow(sessionId);
		if (updates.providerId !== undefined)
			session.config.providerId = updates.providerId;
		if (updates.modelId !== undefined) session.config.modelId = updates.modelId;
		if (updates.apiKey !== undefined) session.config.apiKey = updates.apiKey;
		if (updates.baseUrl !== undefined) session.config.baseUrl = updates.baseUrl;
		if (updates.headers !== undefined) session.config.headers = updates.headers;
		if (updates.providerConfig !== undefined)
			session.config.providerConfig = updates.providerConfig;
		if (Object.hasOwn(updates, "reasoningEffort")) {
			session.config.reasoningEffort = updates.reasoningEffort ?? undefined;
		}
		if (Object.hasOwn(updates, "thinkingBudgetTokens")) {
			session.config.thinkingBudgetTokens =
				updates.thinkingBudgetTokens ?? undefined;
		}
		if (Object.hasOwn(updates, "thinking")) {
			session.config.thinking = updates.thinking ?? undefined;
			if (updates.thinking === false || updates.thinking === null) {
				session.config.reasoningEffort = undefined;
				session.config.thinkingBudgetTokens = undefined;
			}
		}
		const delegatedUpdates = {
			...(updates.providerId !== undefined
				? { providerId: updates.providerId }
				: {}),
			...(updates.modelId !== undefined ? { modelId: updates.modelId } : {}),
			...(updates.apiKey !== undefined ? { apiKey: updates.apiKey } : {}),
			...(updates.baseUrl !== undefined ? { baseUrl: updates.baseUrl } : {}),
			...(updates.headers !== undefined ? { headers: updates.headers } : {}),
			...(updates.providerConfig !== undefined
				? { providerConfig: updates.providerConfig }
				: {}),
			...(Object.hasOwn(updates, "reasoningEffort")
				? { reasoningEffort: updates.reasoningEffort ?? undefined }
				: {}),
			...(Object.hasOwn(updates, "thinking")
				? { thinking: updates.thinking ?? undefined }
				: {}),
			...(Object.hasOwn(updates, "thinkingBudgetTokens")
				? { thinkingBudgetTokens: updates.thinkingBudgetTokens ?? undefined }
				: {}),
		};
		if (updates.thinking === false || updates.thinking === null) {
			delegatedUpdates.reasoningEffort = undefined;
			delegatedUpdates.thinkingBudgetTokens = undefined;
		}
		const teammateUpdates = {
			...(updates.apiKey !== undefined ? { apiKey: updates.apiKey } : {}),
			...(updates.baseUrl !== undefined ? { baseUrl: updates.baseUrl } : {}),
			...(updates.headers !== undefined ? { headers: updates.headers } : {}),
		};
		session.runtime.delegatedAgentConfigProvider?.updateConnectionDefaults(
			delegatedUpdates,
		);
		session.agent.updateConnection(updates);
		session.runtime.teamRuntime?.updateTeammateConnections(teammateUpdates);
		// Keep the persisted manifest in sync so session history reflects the
		// connection the session is now using, not the one it started with.
		if (updates.providerId || updates.modelId) {
			await this.mutateSessionManifest(session, (manifest) => {
				if (updates.providerId) manifest.provider = updates.providerId;
				if (updates.modelId) manifest.model = updates.modelId;
			});
		}
	}

	/**
	 * Serialized read-modify-write for a live session's manifest. Every
	 * manifest write for an active session MUST go through this helper: it
	 * re-reads the disk manifest first so disk-only writers (compaction-path
	 * updates, title/metadata renames) are never reverted by a stale in-memory
	 * copy, applies the field-level mutation, syncs the in-memory copy, and
	 * persists — one mutation at a time per session.
	 */
	private async mutateSessionManifest(
		session: ActiveSession,
		mutate: (manifest: SessionManifest) => void,
	): Promise<SessionManifest | undefined> {
		const artifacts = session.artifacts;
		if (!artifacts) return undefined;
		const sessionId = session.sessionId;
		const tail =
			this.manifestMutationQueues.get(sessionId) ?? Promise.resolve();
		const next = tail.then(async () => {
			const latest =
				(await this.invokeOptionalValue<SessionManifest>(
					"readSessionManifest",
					sessionId,
				)) ?? artifacts.manifest;
			mutate(latest);
			artifacts.manifest = latest;
			await this.invoke<void>(
				"writeSessionManifest",
				artifacts.manifestPath,
				latest,
			);
			return latest;
		});
		const queued = next.then(
			() => undefined,
			() => undefined,
		);
		this.manifestMutationQueues.set(sessionId, queued);
		try {
			return await next;
		} finally {
			if (this.manifestMutationQueues.get(sessionId) === queued) {
				this.manifestMutationQueues.delete(sessionId);
			}
		}
	}

	// Retained for unit tests that reach in via Reflect.
	handlePluginEvent(
		rootSessionId: string,
		event: { name: string; payload?: unknown },
		fallbackAutomation?: NonNullable<
			CoreSessionConfig["extensionContext"]
		>["automation"],
	): Promise<void> {
		return this.eventBridge.handlePluginEvent(
			rootSessionId,
			event,
			fallbackAutomation,
		);
	}

	// ── Session lifecycle ───────────────────────────────────────────────

	private async ensureSessionPersisted(session: ActiveSession): Promise<void> {
		if (session.artifacts) return;
		const workspacePath = resolveWorkspacePath(session.config);
		session.artifacts = (await this.invoke("createRootSessionWithArtifacts", {
			sessionId: session.sessionId,
			source: session.source,
			pid: process.pid,
			// Seeded sessions (forks, checkpoint restores) materialize at start
			// while idle; the service otherwise defaults the row to "running",
			// and a later restore that reuses the id resumes from that stale
			// manifest status and reports a turn that never existed.
			status: session.status,
			interactive: session.interactive,
			provider: session.config.providerId,
			model: session.config.modelId,
			cwd: session.config.cwd,
			workspaceRoot: workspacePath,
			teamName: session.config.teamName,
			enableTools: session.config.enableTools,
			enableSpawn: session.config.enableSpawnAgent,
			enableTeams: session.config.enableAgentTeams,
			prompt: session.pendingPrompt,
			metadata: session.sessionMetadata,
			startedAt: session.startedAt,
		})) as RootSessionArtifacts;
		if (session.compactionState) {
			const result =
				await this.compactionStateStore.persistActiveSessionCompactionState(
					session,
					session.compactionState,
				);
			if (!result.updated) {
				session.compactionState = undefined;
			}
		}
	}

	private async markTurnRunning(session: ActiveSession): Promise<void> {
		if (session.status === "running") return;
		await this.updateStatus(session, "running", null);
	}

	private async refreshActiveSessionGitMetadata(
		session: ActiveSession,
		knownState?: GitWorkspaceState,
	): Promise<void> {
		try {
			const state =
				knownState ??
				(await readGitWorkspaceState(resolveWorkspacePath(session.config)));
			if (!state || !session.artifacts) return;
			if (
				hasCurrentSessionGitMetadata(session.artifacts.manifest.metadata, state)
			) {
				return;
			}
			await this.persistSessionMetadata(session.sessionId, (current) =>
				withSessionGitMetadata(
					{
						...(current ?? {}),
						...(session.sessionMetadata ?? {}),
					},
					state,
				),
			);
		} catch (error) {
			session.config.logger?.debug?.("Failed to refresh session git metadata", {
				sessionId: session.sessionId,
				error,
			});
		}
	}

	private async markTurnPending(session: ActiveSession): Promise<void> {
		if (session.status === "pending") return;
		await this.updateStatus(session, "pending", null);
	}

	private async markTurnIdle(session: ActiveSession): Promise<void> {
		if (session.status === "idle") return;
		await this.updateStatus(session, "idle", null);
	}

	private async persistSessionMetadata(
		sessionId: string,
		resolveMetadata: (
			current: Record<string, unknown> | undefined,
		) => Record<string, unknown> | undefined,
	): Promise<void> {
		const session = this.sessions.get(sessionId);
		const currentManifest =
			(await this.invokeOptionalValue<SessionManifest>(
				"readSessionManifest",
				sessionId,
			)) ?? session?.artifacts?.manifest;
		const metadata = resolveMetadata(
			currentManifest?.metadata as Record<string, unknown> | undefined,
		);
		if (!session?.artifacts) {
			return;
		}
		const result = await this.invokeOptionalValue<{ updated?: boolean }>(
			"updateSession",
			{
				sessionId,
				metadata,
			},
		);
		if (result?.updated === false) {
			return;
		}
		session.sessionMetadata = metadata;
		session.artifacts.manifest.metadata = metadata;
	}

	private async finalizeSingleRun(
		session: ActiveSession,
		finishReason: AgentResult["finishReason"],
	): Promise<void> {
		if (hasPendingTeamRunWork(session)) return;
		const isAborted = finishReason === "aborted" || session.aborting;
		const isError = finishReason === "error";
		await this.shutdownSession(session, {
			status: isAborted ? "cancelled" : isError ? "failed" : "completed",
			exitCode: isError ? 1 : 0,
			shutdownReason: isError ? "session_error" : "session_complete",
			endReason: finishReason,
		});
	}

	private async failSession(session: ActiveSession): Promise<void> {
		// The failing turn is this session's final turn. Record it so a later
		// stop cannot read a stale "completed" left over from an earlier
		// successful turn and report the errored session as completed.
		session.lastInteractiveTurnFinishReason = "error";
		await this.shutdownSession(session, {
			status: "failed",
			exitCode: 1,
			shutdownReason: "session_error",
			endReason: "error",
		});
	}

	private async shutdownSession(
		session: ActiveSession,
		input: {
			status: SessionStatus;
			exitCode: number | null;
			shutdownReason: string;
			endReason: string;
		},
	): Promise<void> {
		notifyTeamRunWaiters(session);

		// Drain an in-flight run before tearing anything down. `stopSession` aborts
		// first for exactly this reason; callers that arrive here another way — hub
		// `dispose()` on a restart, most notably — otherwise hit two failures at
		// once: the runtime refuses to shut down while a run is in progress, and the
		// plugin sandbox is SIGTERMed with tool calls still pending, so those calls
		// reject with "plugin-sandbox process exited". A connector turn awaiting the
		// run sees whichever surfaced first instead of an answer.
		if (!session.aborting && !session.agent.canStartRun()) {
			session.aborting = true;
			session.agent.abort(new Error(input.shutdownReason));
		}

		const cleanupErrors: unknown[] = [];
		const recordCleanupError = (stage: string, error: unknown) => {
			cleanupErrors.push(error);
			session.config.logger?.log("Session shutdown cleanup failed", {
				sessionId: session.sessionId,
				stage,
				error,
				severity: "warn",
			});
		};

		if (session.artifacts) {
			await this.refreshActiveSessionGitMetadata(session);
			try {
				await this.updateStatus(session, input.status, input.exitCode);
			} catch (error) {
				recordCleanupError("update_status", error);
			}
		}
		try {
			await session.agent.shutdown(input.shutdownReason);
		} catch (error) {
			recordCleanupError("agent_shutdown", error);
		}
		try {
			await Promise.resolve(session.runtime.shutdown(input.shutdownReason));
		} catch (error) {
			recordCleanupError("runtime_shutdown", error);
		}
		try {
			await session.pluginSandboxShutdown?.();
		} catch (error) {
			recordCleanupError("plugin_sandbox_shutdown", error);
		}
		this.sessions.delete(session.sessionId);
		this.emit({
			type: "ended",
			payload: {
				sessionId: session.sessionId,
				reason: input.endReason,
				ts: Date.now(),
			},
		});
		if (cleanupErrors.length > 0 && input.status === "failed") {
			throw cleanupErrors[0];
		}
	}

	private async releaseSessionRuntime(
		session: ActiveSession,
		reason: string,
	): Promise<void> {
		const cleanupErrors: unknown[] = [];
		const recordCleanupError = (stage: string, error: unknown) => {
			cleanupErrors.push(error);
			session.config.logger?.log("Session runtime cleanup failed", {
				sessionId: session.sessionId,
				stage,
				error,
				severity: "warn",
			});
		};

		// Drain an in-flight run before tearing anything down, the same way
		// stopSession does for its non-interactive path.
		//
		// Without this, releasing a session that is mid-run fails twice over: the
		// runtime refuses to shut down ("a run is in progress") and that error is
		// rethrown below, and the plugin sandbox is SIGTERMed while tool calls are
		// still pending, so those calls reject with "plugin-sandbox process exited".
		// A connector turn awaiting the run sees whichever surfaced first instead of
		// an answer — which is what a hub restart looked like from Slack.
		if (!session.aborting && !session.agent.canStartRun()) {
			session.aborting = true;
			session.agent.abort(new Error(reason));
		}
		try {
			await session.agent.shutdown(reason);
		} catch (error) {
			recordCleanupError("agent_shutdown", error);
		}
		try {
			await Promise.resolve(session.runtime.shutdown(reason));
		} catch (error) {
			recordCleanupError("runtime_shutdown", error);
		}
		try {
			await session.pluginSandboxShutdown?.();
		} catch (error) {
			recordCleanupError("plugin_sandbox_shutdown", error);
		}
		this.sessions.delete(session.sessionId);
		if (cleanupErrors.length > 0) {
			throw cleanupErrors[0];
		}
	}

	private async updateStatus(
		session: ActiveSession,
		status: SessionStatus,
		exitCode?: number | null,
	): Promise<void> {
		if (!session.artifacts) return;
		const result = await this.invoke<{ updated: boolean; endedAt?: string }>(
			"updateSessionStatus",
			session.sessionId,
			status,
			exitCode,
		);
		if (!result.updated) return;
		const latestManifest = await this.mutateSessionManifest(
			session,
			(manifest) => {
				manifest.status = status;
				if (isNonTerminalSessionStatus(status)) {
					delete manifest.ended_at;
					manifest.exit_code = null;
				} else {
					manifest.ended_at = result.endedAt ?? nowIso();
					manifest.exit_code = typeof exitCode === "number" ? exitCode : null;
				}
			},
		);
		if (!latestManifest) return;
		session.status = status;
		session.updatedAt = result.endedAt ?? nowIso();
		session.endedAt = isNonTerminalSessionStatus(status)
			? null
			: latestManifest.ended_at;
		session.exitCode = latestManifest.exit_code;
		this.emitStatus(session.sessionId, status);
	}

	// ── OAuth & auth ────────────────────────────────────────────────────

	private async syncOAuthCredentials(
		session: ActiveSession,
		options?: { forceRefresh?: boolean },
	): Promise<void> {
		let resolved: RuntimeOAuthResolution | null = null;
		try {
			resolved = await this.oauthTokenManager.resolveProviderApiKey({
				providerId: session.config.providerId,
				forceRefresh: options?.forceRefresh,
			});
		} catch (error) {
			if (error instanceof OAuthReauthRequiredError) {
				throw new Error(`${error.providerId} requires re-authentication.`);
			}
			throw error;
		}
		if (!resolved?.apiKey || session.config.apiKey === resolved.apiKey) return;
		session.config.apiKey = resolved.apiKey;
		session.agent.updateConnection({ apiKey: resolved.apiKey });
		session.runtime.delegatedAgentConfigProvider?.updateConnectionDefaults({
			apiKey: resolved.apiKey,
		});
		session.runtime.teamRuntime?.updateTeammateConnections({
			apiKey: resolved.apiKey,
		});
	}

	// ── Utility methods ─────────────────────────────────────────────────

	private getSessionOrThrow(sessionId: string): ActiveSession {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new SessionNotFoundError(sessionId);
		}
		return session;
	}

	private emitStatus(sessionId: string, status: string): void {
		void this.emitSessionSnapshot(sessionId);
		this.emit({
			type: "status",
			payload: { sessionId, status },
		});
	}

	// The emitted snapshot is a state notification (status, usage, workspace,
	// checkpoint) and deliberately omits the transcript: emitStatus fires this
	// on every status flip, so including messages would re-read and broadcast
	// the entire conversation each time. Consumers that need messages read
	// them explicitly via readSessionMessages / the session.messages command.
	private async emitSessionSnapshot(sessionId: string): Promise<void> {
		const session = await this.getSession(sessionId);
		if (!session) return;
		this.emit({
			type: "session_snapshot",
			payload: {
				sessionId,
				snapshot: createCoreSessionSnapshot({
					session,
					usage: this.usageBySession.get(sessionId),
					aggregateUsage: this.aggregateUsageBySession.get(sessionId),
				}),
			},
		});
	}

	private emit(event: CoreSessionEvent): void {
		this.events.emit(event);
	}

	private async listRows(
		limit: number,
		options: ListSessionsOptions = {},
	): Promise<SessionRow[]> {
		return this.invoke<SessionRow[]>(
			"listSessions",
			Math.min(Math.max(1, Math.floor(limit)), MAX_SCAN_LIMIT),
			options,
		);
	}

	private async getRow(sessionId: string): Promise<SessionRow | undefined> {
		const target = sessionId.trim();
		if (!target) return undefined;
		const rows = await this.listRows(MAX_SCAN_LIMIT);
		return rows.find((row) => row.sessionId === target);
	}

	private async readManifest(
		sessionId: string,
	): Promise<SessionManifest | undefined> {
		const target = sessionId.trim();
		if (!target) return undefined;
		return await this.invokeOptionalValue<SessionManifest>(
			"readSessionManifest",
			target,
		);
	}

	// ── Session service invocation ──────────────────────────────────────

	private invoke<T>(method: string, ...args: unknown[]): Promise<T> {
		return invokeBackend<T>(this.sessionService, method, ...args);
	}

	private invokeOptional(method: string, ...args: unknown[]): Promise<void> {
		return invokeBackendOptional(this.sessionService, method, ...args);
	}

	private invokeOptionalValue<T = unknown>(
		method: string,
		...args: unknown[]
	): Promise<T | undefined> {
		return invokeBackendOptionalValue<T>(this.sessionService, method, ...args);
	}
}

/**
 * The source tool of a session imported from another agent (Claude Code, Codex,
 * opencode), read from its `importedFrom` metadata. Such sessions get a
 * one-off compaction of the imported history when they are resumed.
 */
function readImportedFromTool(
	metadata: Record<string, unknown> | null | undefined,
): string | undefined {
	const value = metadata?.importedFrom;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	return typeof record.tool === "string" &&
		typeof record.sourceSessionId === "string"
		? record.tool
		: undefined;
}
