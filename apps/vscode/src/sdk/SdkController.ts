// Replaces classic src/core/controller/index.ts (see origin/main)
//
// The SDK-backed Controller. It provides the same interface as the classic
// Controller but delegates session lifecycle (initTask, askResponse,
// cancelTask, …) to the Cline SDK (@plinycode/core) and bridges SDK events to
// the webview's gRPC streams.
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { createRestoredCheckpointMetadata, resolveDefaultMcpSettingsPath, retainCheckpointRefs } from "@plinycode/core"
import { type AgentStopControl, formatDisplayUserInput, stripModeNotices } from "@plinycode/shared"
import { resolveClineDataDir } from "@plinycode/shared/storage"
import type { ChatContent } from "@shared/ChatContent"
import type { ClineMessage, ExtensionState } from "@shared/ExtensionMessage"
import { getConversationApiMetrics } from "@shared/getApiMetrics"
import type { HistoryItem, TaskWorktree } from "@shared/HistoryItem"
import { isPlinyFreeModelId } from "@shared/pliny"
import { LatestChangesSummary } from "@shared/proto/cline/checkpoints"
import { DeleteAllTaskHistoryCount, type GetTaskHistoryRequest, TaskHistoryArray, TaskResponse } from "@shared/proto/cline/task"
import type { Settings } from "@shared/storage/state-keys"
import { type Mode, toMode } from "@shared/storage/types"
import type { ClineAskResponse, ClineCheckpointRestore } from "@shared/WebviewMessage"
import { workspacePathsEqual } from "@shared/workspacePath"
import type { WorkspaceRef } from "@shared/workspaceRef"
import { createTaskApiModelShim } from "@/core/controller/models/taskApiModel"
import { sendChatButtonClickedEvent } from "@/core/controller/ui/subscribeToChatButtonClicked"
import { renderConversationMarkdown } from "@/core/export/markdown"
import { defaultMarkdownExportFilename, saveMarkdownExport } from "@/core/export/save-markdown"
import { ensureMcpServersDirectoryExists } from "@/core/storage/disk"
import { StateManager } from "@/core/storage/StateManager"
import type { WorkspaceRootManager } from "@/core/workspace/WorkspaceRootManager"
import { HostProvider } from "@/hosts/host-provider"
import { getAdvisorSettings } from "@/hosts/vscode/advisor-settings"
import { createVscodeCodeIntelSource, isCodeIntelEnabled } from "@/hosts/vscode/code-intel-source"
import { createVscodeEditDiagnosticsSource, isReportNewProblemsEnabled } from "@/hosts/vscode/edit-diagnostics"
import { isMemoryDistillOfferEnabled } from "@/hosts/vscode/memory-settings"
import { getRouterImageMode } from "@/hosts/vscode/router-image-settings"
import { getConversationSpendingLimit } from "@/hosts/vscode/spending-settings"
import { VscodeTerminalManager } from "@/hosts/vscode/terminal/VscodeTerminalManager"
import { isSessionTraceEnabled } from "@/hosts/vscode/trace-settings"
import { createVscodeWebSearchSetup } from "@/hosts/vscode/web-search-settings"
import { configuredTaskWorktreeFolder } from "@/hosts/vscode/worktree-settings"
import { ExtensionRegistryInfo } from "@/registry"
import { getCiBoard, onBuiltinMcpToolsChanged, waitForCiWatchRepoOpener } from "@/services/devops-mcp/builtin-mcp-registry"
import { openCiWatchSource } from "@/services/devops-mcp/ci-watch/ci-watch-source"
import { CiWatchStore } from "@/services/devops-mcp/ci-watch/ci-watch-store"
import type { WorktreeConversation } from "@/services/git/worktree-gc"
import { ensureTaskWorktree } from "@/services/git/worktrees"
import { McpHub } from "@/services/mcp/McpHub"
import type { ClineExtensionContext } from "@/shared/cline"
import { coerceToPlinyProvider } from "@/shared/pliny"
import { ShowMessageRequest, ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { checkAdvisorBudget } from "./advisor/advisor-budget"
import { CiRunPolicies, type CiRunPolicy, decideCiTool } from "./ci-run-policy"
import { buildStartSessionInput } from "./cline-session-factory"
import { describeRenameForApproval } from "./code-intel/code-intel-tools"
import { type ConversationContext, createConversationContext } from "./context"
import { createHookStatusRows } from "./hook-status-rows"
import { createMemoryServices, type MemoryServices } from "./memory"
import { MemoryCoordinator } from "./memory/memory-coordinator"
import { completeWithUtilityModel } from "./memory/memory-model"
import { compactionUsageFromNotice, MessageTranslatorState, normalizeUsageEvent } from "./message-translator"
import type { SubagentTranscripts } from "./message-translator/subagent-transcripts"
import { createProviderCatalog } from "./model-catalog/catalog"
import type { Disposable, ProviderCatalog, ProviderConfigChange, ProviderConfigStore } from "./model-catalog/contracts"
import { createProviderConfigStore } from "./model-catalog/store"
import type { ModelCallUsage } from "./one-shot-model-call"
import { ProcessRegistry } from "./processes/process-registry"
import { emitTurnSummary } from "./router/router-integration"
import { MAX_BACKGROUND_SESSIONS, SdkBackgroundSessions } from "./sdk-background-sessions"
import { SdkCheckpointCoordinator } from "./sdk-checkpoint-coordinator"
import { describeEditedRow, getCheckpointRunCountForMessage } from "./sdk-checkpoints"
import { SdkCiWatchCoordinator } from "./sdk-ci-watch-coordinator"
import { SdkCompactionCoordinator } from "./sdk-compaction-coordinator"
import { SdkDiffEditCoordinator } from "./sdk-diff-edit-coordinator"
import { type FollowUpOptions, SdkFollowupCoordinator } from "./sdk-followup-coordinator"
import { SdkForegroundCommandCoordinator } from "./sdk-foreground-command-coordinator"
import { SdkInteractionCoordinator } from "./sdk-interaction-coordinator"
import { SdkMcpCoordinator } from "./sdk-mcp-coordinator"
import { SdkMessageCoordinator, type SessionEventListener } from "./sdk-message-coordinator"
import { SdkModeCoordinator } from "./sdk-mode-coordinator"
import { SdkSessionConfigBuilder } from "./sdk-session-config-builder"
import { SdkSessionEventCoordinator } from "./sdk-session-event-coordinator"
import { SdkSessionHistoryLoader } from "./sdk-session-history-loader"
import { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import { SdkSessionRebuildScheduler } from "./sdk-session-rebuild-scheduler"
import { SdkSlashMentionResolver } from "./sdk-slash-mention-resolver"
import { type ClearTaskOptions, SdkTaskControlCoordinator } from "./sdk-task-control-coordinator"
import {
	createHistoryItemFromSession,
	mergeTaskHistoryIntoState,
	metadataBoolean,
	metadataNumber,
	metadataWorktree,
	SdkTaskHistory,
	sessionHistoryRecordToTaskItemFields,
} from "./sdk-task-history"
import { type BackgroundStartResult, SdkTaskStartCoordinator, type TaskStartOptions } from "./sdk-task-start-coordinator"
import { SdkTerminalExecutionModeCoordinator } from "./sdk-terminal-execution-mode-coordinator"
import { isToolAutoApproved } from "./sdk-tool-policies"
import { extractSdkUserText, isSyntheticSdkUserMessage, planEditRestart, type SdkUserMessage } from "./sdk-user-message-mapping"
import { SdkWorkspaceRootResolver } from "./sdk-workspace-root-resolver"
import { checkConversationBudget } from "./spending-limit"
import { StatePostDebouncer } from "./state-post-debouncer"
import {
	isSessionRecordFavorited,
	isSessionRecordPinned,
	queryTaskHistoryWithContent,
	sessionRecordLastActiveTs,
	sessionRecordTitle,
	type TaskHistoryQuery,
	taskHistoryRowMatches,
} from "./task-history-query"
import { createTaskProxy, type TaskProxy } from "./task-proxy"
import { readTaskUsageTotals } from "./task-usage-metadata"
import { TurnStateTracker } from "./turn-state-tracker"
import { createWorkspaceFileReadExecutor } from "./vscode-file-read-executor"
import { VscodeSessionHost } from "./vscode-session-host"
import type { VscodeTerminalExecutionMode } from "./vscode-terminal-execution-mode"
import { WebviewGrpcBridge } from "./webview-grpc-bridge"

/** How long a CI watch restored after a reload waits for the DevOps service before its poll fails. */
const DEVOPS_WAIT_MS = 2 * 60_000

function historyItemToTaskResponse(item: HistoryItem): TaskResponse {
	return TaskResponse.create({
		id: item.id,
		task: formatDisplayUserInput(item.task),
		ts: item.ts,
		isFavorited: item.isFavorited ?? false,
		size: item.size ?? 0,
		totalCost: item.totalCost ?? 0,
		tokensIn: item.tokensIn ?? 0,
		tokensOut: item.tokensOut ?? 0,
		cacheWrites: item.cacheWrites ?? 0,
		cacheReads: item.cacheReads ?? 0,
		isLegacy: item.isLegacy ?? false,
	})
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class Controller {
	// SDK session state and the coordinators that drive it.
	private messageTranslatorState: MessageTranslatorState
	/** The conversation the sub-agent transcripts belong to; see resetMessageTranslatorAndFence. */
	private subagentTranscriptsTaskId: string | undefined
	private turnStateTracker!: TurnStateTracker
	private messages: SdkMessageCoordinator
	private sessions: SdkSessionLifecycle
	private sessionRebuilds: SdkSessionRebuildScheduler
	private interactions: SdkInteractionCoordinator
	private diffEdits: SdkDiffEditCoordinator
	private sessionConfigBuilder: SdkSessionConfigBuilder
	private taskHistory: SdkTaskHistory
	private mode: SdkModeCoordinator
	private mcpTools: SdkMcpCoordinator
	private terminalExecutionMode: SdkTerminalExecutionModeCoordinator
	private followups: SdkFollowupCoordinator
	private taskControl: SdkTaskControlCoordinator
	private taskStart: SdkTaskStartCoordinator
	private compaction: SdkCompactionCoordinator
	private sessionEvents: SdkSessionEventCoordinator
	private sessionHistory: SdkSessionHistoryLoader
	private readonly providerConfigStore: ProviderConfigStore
	private readonly providerCatalog: ProviderCatalog
	private readonly providerConfigStoreSubscription: Disposable
	private providerConfigStatePostScheduled = false

	// Debounces/coalesces postStateToWebview() calls — see StatePostDebouncer.
	private static readonly STATE_POST_DEBOUNCE_MS = 50
	private readonly statePostDebouncer: StatePostDebouncer

	// Bridges SDK events to the webview's gRPC streams.
	private grpcBridge: WebviewGrpcBridge

	// Presents the Task interface that gRPC handlers expect, delegating to the
	// active SDK session.
	task?: TaskProxy

	mcpHub: McpHub
	readonly stateManager: StateManager

	// Lazy terminal manager for foreground (VS Code terminal) command execution.
	// Created on first use; shared across all sessions in this Controller's lifetime.
	// Only used in the `vscodeTerminal` execution mode — `backgroundExec` and the
	// standalone (JetBrains/CLI) host run commands through the SDK's built-in tool.
	private _terminalManager?: VscodeTerminalManager

	// Registry of in-flight foreground (VS Code terminal) command executions.
	// Owned here — not by the session — so it survives session rebuilds, which
	// recreate the tool set. Drives the "Proceed While Running" button.
	private readonly foregroundCommands = new SdkForegroundCommandCoordinator({
		onRunningChanged: () => {
			void this.postStateToWebview()
		},
		isForegroundSession: (sessionId) => !this.background?.has(sessionId),
	})

	// Commands that outlive their run_commands call: handed over to the terminal
	// while still running, or started with `background: true`. Owned here so it
	// survives session rebuilds; drives the webview's background-command flag
	// and cancelBackgroundCommand (docs/agent-tools.md, "Background processes").
	private readonly processes = new ProcessRegistry()
	private readonly processesSubscription = this.processes.onDidChange(() => {
		void this.postStateToWebview()
	})

	// Tasks that keep running after the user starts a new task or opens another
	// one. Created in the constructor; its callbacks reach session state lazily.
	private readonly background: SdkBackgroundSessions
	/** The approval policies of CI board runs started in this window. */
	private readonly ciRunPolicies = new CiRunPolicies()
	private readonly backgroundReleasedListeners = new Set<(sessionId: string) => void>()

	// CI watches started with the watch_ci tool, and the delivery of their
	// reports into conversations — see sdk-ci-watch-coordinator.ts.
	private readonly ciWatch: SdkCiWatchCoordinator

	checkpointRestoreInput?: ExtensionState["checkpointRestoreInput"]
	editMessageRestartFocus?: ExtensionState["editMessageRestartFocus"]

	private unsubscribeBuiltinMcp?: () => void

	private isDisposed = false

	// Checkpoint restore and "view changes" comparisons — see sdk-checkpoint-coordinator.ts.
	private checkpoints!: SdkCheckpointCoordinator
	// Slash-command expansion and @-mention resolution — see sdk-slash-mention-resolver.ts.
	private readonly slashMentions: SdkSlashMentionResolver
	// Workspace root / window workspace / WorkspaceRootManager resolution — see
	// sdk-workspace-root-resolver.ts.
	private readonly workspaceRootResolver: SdkWorkspaceRootResolver
	// Git snapshot in the system prompt and editor state on user messages — see context/index.ts.
	private readonly conversationContext: ConversationContext = createConversationContext({
		readSessionMetadata: (conversationId) => this.taskHistory.getSessionMetadata(conversationId),
		getWorkspaceRoot: () => this.getWorkspaceRoot(),
	})

	// Repo memory and past-conversation search — see memory/index.ts and docs/memory.md.
	private readonly memoryServices: MemoryServices = createMemoryServices({
		listSessions: (limit) => this.taskHistory.listSessionRecords(limit),
		readMessages: (sessionId) => this.taskHistory.readSessionMessages(sessionId),
	})
	/** Memory distillation and its proposal rows; the RPC handlers reach it here. */
	readonly memory: MemoryCoordinator

	// Synchronous snapshot of getWorkspaceRoot()'s latest result, for the message
	// translator (which runs synchronously and relativizes the tool paths shown in
	// the chat view). Warmed in the constructor and refreshed on every call.
	private lastKnownWorkspaceRoot?: string
	/**
	 * The workspace the displayed task runs in, set by task start and resume and
	 * cleared with the task. While set, getWorkspaceRoot() resolves here, so a
	 * conversation started in another workspace than the window's keeps its
	 * mentions, edits and session rebuilds in that workspace.
	 */
	private activeTaskWorkspace?: { workspace?: WorkspaceRef; cwd: string }
	/** Most recently used workspaces, shared with the other windows through a file. */
	get recentWorkspaces(): SdkWorkspaceRootResolver["recentWorkspaces"] {
		return this.workspaceRootResolver.recentWorkspaces
	}

	constructor(readonly context: ClineExtensionContext) {
		// StateManager must be initialized before creating the Controller
		this.stateManager = StateManager.get()
		this.statePostDebouncer = new StatePostDebouncer({
			debounceMs: Controller.STATE_POST_DEBOUNCE_MS,
			flush: () => this.flushStateToWebview(),
		})
		this.providerConfigStore = createProviderConfigStore()
		this.providerCatalog = createProviderCatalog(this.providerConfigStore)
		this.providerConfigStoreSubscription = this.providerConfigStore.subscribe((event) => {
			this.handleProviderConfigChange(event)
		})
		this.workspaceRootResolver = new SdkWorkspaceRootResolver({
			getActiveTaskWorkspace: () => this.activeTaskWorkspace,
			onWorkspaceRootResolved: (workspaceRoot) => {
				this.lastKnownWorkspaceRoot = workspaceRoot
			},
		})
		this.slashMentions = new SdkSlashMentionResolver({
			stateManager: this.stateManager,
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			ensureWorkspaceManager: () => this.ensureWorkspaceManager(),
		})

		// IMPORTANT: Use ~/.cline/data/settings/ for the settings directory,
		// NOT ensureSettingsDirectoryExists() which returns the VSCode extension
		// storage path (HostProvider.globalStorageFsPath/settings/). The MCP
		// settings file lives at ~/.cline/data/settings/cline_mcp_settings.json
		// (shared across VSCode, CLI, and JetBrains clients).
		this.mcpHub = new McpHub(
			() => ensureMcpServersDirectoryExists(),
			async () => {
				const settingsDir = path.dirname(resolveDefaultMcpSettingsPath())
				await fs.mkdir(settingsDir, { recursive: true })
				return settingsDir
			},
			ExtensionRegistryInfo.version,
		)

		// Initialize message translator state. The mode getter styles the inferred turn-final
		// completion row (plan → yellow plan box, act → green completion box).
		this.messageTranslatorState = new MessageTranslatorState(
			undefined,
			// Provider backing the active turn — error reshaping branches on it
			// (BYOK credential guidance vs the cline sign-in card). Prefer the
			// active session's start metadata over the current settings
			// selection: a provider/mode switch made while a turn is in flight
			// changes the settings selection immediately, but the failing turn
			// still belongs to the session's provider. Provider switches always
			// start a new session, so start metadata never goes stale the way
			// a mid-task model-only switch does for models below.
			() => this.getSessionProviderId() ?? this.getActiveProviderId(),
			() => (this.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"),
			() => this.lastKnownWorkspaceRoot,
			// Model backing the active turn — lets error reshaping recognize
			// retired cline-free/ models (the error payload itself never names one).
			// The task shim is preferred over session-start metadata: a mid-task
			// model-only switch updates the running session's model in place
			// (updateActiveSessionModel) and refreshes the shim, but never touches
			// startConfig/manifest, which would otherwise report the stale model.
			// The shim starts as "unknown" (filtered out by getTaskModelId), so
			// fresh sessions still resolve through their start metadata.
			() => this.getTaskModelId() ?? this.getSessionModelId(),
		)
		// Warm the synchronous workspace-root snapshot used for display-path
		// relativization (getWorkspaceRoot never rejects — it falls back internally).
		void this.getWorkspaceRoot()
		// Authoritative UI-mode tracker, sharing the one id/seq/epoch authority.
		this.turnStateTracker = new TurnStateTracker(this.messageTranslatorState.getMinter())
		this.messages = new SdkMessageCoordinator({
			getTask: () => this.task,
			// Stamp seq/epoch on every message flowing to the webview from the shared authority.
			getMinter: () => this.messageTranslatorState.getMinter(),
		})
		this.sessionHistory = new SdkSessionHistoryLoader()
		this.background = new SdkBackgroundSessions({
			stopSession: (session, reason) => this.sessions.stopSession(session, reason),
			recordUsage: (sessionId, event) => {
				if (event.type === "notice") {
					// The compaction summarizer's call, which the engine's usage leaves out.
					const summarizer = compactionUsageFromNotice(event)
					if (summarizer) {
						const usage = {
							tokensIn: summarizer.tokensIn,
							tokensOut: summarizer.tokensOut,
							cacheReads: summarizer.cacheReads,
							cacheWrites: summarizer.cacheWrites,
							totalCost: summarizer.cost,
						}
						Promise.resolve(this.taskHistory.updateTaskUsage(sessionId, usage, "compaction")).catch((error) => {
							Logger.error("[SdkController] Failed to persist background compaction usage:", error)
						})
					}
					return
				}
				if (event.type !== "usage") {
					return
				}
				Promise.resolve(this.taskHistory.updateTaskUsage(sessionId, normalizeUsageEvent(event))).catch((error) => {
					Logger.error("[SdkController] Failed to persist background task usage:", error)
				})
			},
			notify: (message, onOpen) => {
				void HostProvider.window
					.showMessage({ type: ShowMessageType.INFORMATION, message, options: { items: ["Open"] } })
					.then((response) => {
						if (response.selectedOption === "Open") {
							onOpen()
						}
					})
					.catch((error) => Logger.warn("[SdkController] Failed to show background task notification:", error))
			},
			openTask: (sessionId) => {
				void this.showTaskWithId(sessionId)
					.then(() => sendChatButtonClickedEvent())
					.catch((error) => Logger.warn(`[SdkController] Failed to open background task ${sessionId}:`, error))
			},
			onChanged: () => {
				void this.postStateToWebview()
				getCiBoard()?.touch()
			},
			onReleased: (sessionId) => {
				// Out of the background, someone is watching again: the user's settings apply.
				const policy = this.ciRunPolicies.get(sessionId)
				if (policy?.scope === "auto") {
					this.ciRunPolicies.set(sessionId, { ...policy, scope: "guard" })
				}
				for (const listener of this.backgroundReleasedListeners) listener(sessionId)
				getCiBoard()?.touch()
			},
		})
		this.ciWatch = new SdkCiWatchCoordinator({
			getDisplayedTaskId: () => this.task?.taskId,
			getActiveSession: () => this.sessions.getActiveSession(),
			getTurnPhase: () => this.turnStateTracker.currentPhase,
			hasPendingInteraction: () => this.interactions.hasPending,
			queueToActiveSession: (session, prompt) =>
				this.sessions.fireAndForgetSend(session.sdkHost, session.sessionId, prompt, undefined, undefined, "queue"),
			queueToBackgroundTask: (conversationId, prompt) => this.background.queuePrompt(conversationId, prompt),
			startTurn: (prompt) => this.askResponse(prompt),
			emitRow: (text) =>
				this.messages.emitHookMessage({
					ts: this.messageTranslatorState.getMinter().nextId(),
					type: "say",
					say: "info",
					text,
					partial: false,
				}),
			notify: (message, onOpen) => {
				void HostProvider.window
					.showMessage({ type: ShowMessageType.INFORMATION, message, options: { items: ["Open"] } })
					.then((response) => {
						if (response.selectedOption === "Open") {
							onOpen()
						}
					})
					.catch((error) => Logger.warn("[SdkController] Failed to show CI watcher notification:", error))
			},
			openTask: (conversationId) => {
				void this.showTaskWithId(conversationId)
					.then(() => sendChatButtonClickedEvent())
					.catch((error) => Logger.warn(`[SdkController] Failed to open watched task ${conversationId}:`, error))
			},
			// Watches survive a window reload; each window workspace resumes its own (docs/devops-mcp.md).
			persistence: {
				store: new CiWatchStore(
					path.join(resolveClineDataDir(), "ci-watches.json"),
					this.workspaceRootResolver.getWindowWorkspace().then((workspace) => workspace?.path ?? ""),
				),
				conversationExists: async (id) => (await this.taskHistory.findHistoryItem(id)) !== undefined,
				openSource: (target, head) =>
					openCiWatchSource((cwd) => waitForCiWatchRepoOpener(DEVOPS_WAIT_MS).then((open) => open(cwd)), target, head),
			},
		})
		this.sessionConfigBuilder = new SdkSessionConfigBuilder({
			stateManager: this.stateManager,
			onConsecutiveMistakeLimitReached: (context) => this.interactions.handleConsecutiveMistakeLimitReached(context),
			// FreeAuto routing rows. They are ordinary persisted chat rows, minted
			// from the shared id authority so they never collide with
			// translator-minted ids.
			getSessionId: () => this.sessions.getActiveSession()?.sessionId ?? "",
			emitRow: (msg) => this.messages.emitHookMessage(msg),
			nextMessageTs: () => this.messageTranslatorState.getMinter().nextId(),
			isBackgroundSession: (sessionId) => this.background.has(sessionId),
			isOffTheRecordTurn: (sessionId) => this.sessions.isOffTheRecordTurn(sessionId),
			checkSpendingLimit: () => this.checkSpendingLimit(),
			getRunChanges: (sessionId) => this.checkpoints.getRunChanges(sessionId),
			gitSnapshots: this.conversationContext.gitSnapshots,
			promptDates: this.conversationContext.promptDates,
			getConversationId: () => this.task?.taskId,
			memory: this.memoryServices,
			advisor: {
				getSettings: getAdvisorSettings,
				checkBudget: (sessionId) => this.checkAdvisorBudget(sessionId),
				onUsage: (sessionId, usage) => this.recordBackgroundExtraUsage(sessionId, usage, "advisor"),
			},
			routerImages: {
				mode: getRouterImageMode,
				// Mirrored from the webview's "Unlock Pliny paid models" toggle (plinyModelFilter.ts).
				paidModelsUnlocked: () => this.stateManager.getGlobalStateKey("plinyPaidModelsUnlocked") === true,
				// The advisor's rule: also on a free model, refusing the work rather than pausing the run.
				checkBudget: (sessionId) => this.checkAdvisorBudget(sessionId),
				onUsage: (sessionId, usage) => this.recordBackgroundExtraUsage(sessionId, usage, "vision"),
			},
			trace: { enabled: isSessionTraceEnabled },
			pastedCommandBodies: () => this.slashMentions.pastedCommandBodies(),
		})
		this.memory = new MemoryCoordinator({
			store: this.memoryServices.store,
			emitRow: (msg) => this.messages.emitHookMessage(msg),
			nextMessageTs: () => this.messageTranslatorState.getMinter().nextId(),
			getDisplayedConversationId: () => this.task?.taskId,
			readMessages: (conversationId) => this.taskHistory.readSessionMessages(conversationId),
			getCwd: () => this.getWorkspaceRoot(),
			complete: async (system, user, signal) =>
				completeWithUtilityModel(system, user, signal, await this.getWorkspaceRoot()),
			isOfferEnabled: isMemoryDistillOfferEnabled,
			isActMode: (sessionId) => this.sessionMode(sessionId) === "act",
			isBackgroundSession: (sessionId) => this.background.has(sessionId),
			listConversationIds: async () =>
				(await this.taskHistory.listHistory({ hydrate: false })).map((record) => record.sessionId),
		})
		this.diffEdits = new SdkDiffEditCoordinator({
			getCwd: () => this.getWorkspaceRoot(),
			isBackgroundEditEnabled: (sessionId) =>
				!!this.stateManager.getGlobalSettingsKey("backgroundEditEnabled") || this.background.has(sessionId),
			diagnostics: createVscodeEditDiagnosticsSource(),
			isReportNewProblemsEnabled,
		})
		this.interactions = new SdkInteractionCoordinator({
			messages: this.messages,
			getSessionId: () => this.sessions.getActiveSession()?.sessionId ?? "",
			postStateToWebview: () => this.postStateToWebview(),
			// Share the single id/seq/epoch authority so interaction-minted ids (tool-approval
			// asks, ask_question, user_feedback) never collide with translator-minted ids.
			getMinter: () => this.messageTranslatorState.getMinter(),
			setTurnPhase: (phase, anchorTs) => this.turnStateTracker.set(phase, anchorTs),
			// Open the diff editor preview before the approval buttons render.
			onToolApprovalAsk: (request) => this.diffEdits.openForApproval(request.toolCallId, request.toolName, request.input),
			// A rename's input names one symbol; its approval shows the files and lines it edits.
			describeToolApproval: async (request) =>
				request.toolName === "rename_symbol" && isCodeIntelEnabled()
					? describeRenameForApproval(
							{ cwd: await this.getWorkspaceRoot(), source: createVscodeCodeIntelSource() },
							request.input,
						)
					: undefined,
			recordApprovedToolMessage: (toolCallId, messageTs) =>
				this.messageTranslatorState.recordApprovedToolMessageTs(toolCallId, messageTs),
			recordDeniedToolApproval: (toolCallId, toolName, reason) => {
				this.messageTranslatorState.recordDeniedToolApproval(toolCallId, toolName, reason)
				// A denied edit's executor never runs, so close its diff preview here. Covers
				// manual Reject and clearPending (task cancel/abort) in one place.
				void this.diffEdits.discardPreview(toolCallId)
			},
			shouldAutoApproveTool: (request) => {
				const autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")
				return autoApprovalSettings ? isToolAutoApproved(request.toolName, autoApprovalSettings) : false
			},
			sessionPolicy: (request) => {
				const policy = this.ciRunPolicyFor(request.sessionId)
				return policy ? decideCiTool(policy, request.toolName, request.input) : undefined
			},
			getCwd: () => this.lastKnownWorkspaceRoot,
			background: this.background,
			describeAgent: (agentId) => this.messageTranslatorState.subAgentLabel(agentId),
		})
		this.sessions = new SdkSessionLifecycle({
			mcpHub: this.mcpHub,
			requestToolApproval: (request) => this.interactions.handleRequestToolApproval(request),
			askQuestion: (question, options, context) => this.interactions.handleAskQuestion(question, options, context),
			editorExecutor: (input, cwd, context) => this.diffEdits.executeEditorTool(input, cwd, context),
			applyPatchExecutor: (input, cwd, context) => this.diffEdits.executeApplyPatchTool(input, cwd, context),
			// The SDK's built-in reader resolves relative paths against the extension
			// host's process.cwd() (usually "/"); resolve them against the workspace instead.
			readFileExecutor: createWorkspaceFileReadExecutor(() => this.getWorkspaceRoot()),
			onSessionEvent: (event) => {
				this.sessionEvents.handleSessionEvent(event).catch((err) => {
					Logger.error("[SdkController] Failed to handle session event:", err)
				})
			},
			onDidBecomeIdle: () => this.handleSessionBecameIdle(),
			onRunElapsed: (sessionId, elapsedMs) => {
				this.taskHistory.addTaskActiveTime(sessionId, elapsedMs).catch((error) => {
					Logger.error("[SdkController] Failed to persist task running time:", error)
				})
			},
			onDetachedSendSettled: (sessionId, error) => this.background.handleSendSettled(sessionId, error),
			// The engine runs the hook files; each run becomes a hook_status row.
			onHookStatus: createHookStatusRows({
				emitRow: (msg) => this.messages.emitHookMessage(msg),
				nextMessageTs: () => this.messageTranslatorState.getMinter().nextId(),
				isBackgroundSession: (sessionId) => this.background.has(sessionId),
			}),
			foregroundCommands: this.foregroundCommands,
			processes: this.processes,
			getCodeIntel: () => (isCodeIntelEnabled() ? createVscodeCodeIntelSource() : undefined),
			beginEditProblemCheck: (files, cwd) => this.diffEdits.beginExternalEditCheck(files, cwd),
			getWebSearch: () => createVscodeWebSearchSetup(),
			getTerminalManager: () => {
				// Guarded by getEffectiveTerminalExecutionMode() at the read sites
				// (vscode-session-host.ts, sdk-terminal-execution-mode-coordinator.ts):
				// this factory itself is only invoked when a caller has already
				// resolved to "vscodeTerminal" mode on a real VS Code host, but
				// VscodeTerminalManager's constructor still assumes
				// vscode.window.onDidStartTerminalShellExecution exists, which the
				// standalone (JetBrains/CLI) stub does not provide.
				if (!this._terminalManager) {
					this._terminalManager = new VscodeTerminalManager()
					this.applyTerminalSettings(this._terminalManager)
					Logger.log("[SdkController] Created VscodeTerminalManager for foreground terminal execution")
				}
				return this._terminalManager
			},
			// this.mode is assigned later in this constructor; the closure only
			// runs at send time, long after construction completes.
			consumeModeSwitchNotice: (sessionId) => this.mode.consumeModeSwitchNotice(sessionId),
			getSessionStartMetadata: (sessionId) => this.conversationContext.sessionStartMetadata(sessionId),
			editorState: this.conversationContext.editorState,
			onSendComplete: async (sessionId) => {
				// Normal flows close their diff sessions inline; anything left here is orphaned.
				void this.diffEdits.discardAllPreviews("turn complete")
				this.emitRouterTurnSummary(sessionId)
				// Offers memories worth keeping when the run edited files; runs after the turn, never blocks it.
				void this.memory.maybeOfferDistill(sessionId).catch((error) => {
					Logger.warn("[SdkController] Memory distillation failed:", error)
				})

				this.postStateToWebview().catch((err) => {
					Logger.error("[SdkController] Failed to post state after turn:", err)
				})
			},
			onSendError: async (error, sessionId) => {
				// A turn failed — the UI shows error recovery (Retry / Sign In / Add Credits).
				void this.diffEdits.discardAllPreviews("turn error")
				this.emitRouterTurnSummary(sessionId)
				this.turnStateTracker.set("error")
				const errorMessage = error instanceof Error ? error.message : String(error)
				this.messages.emitSessionEvents(
					[
						{
							ts: Date.now(),
							type: "say",
							say: "error",
							text: `Agent error: ${errorMessage}`,
							partial: false,
						},
					],
					{ type: "status", payload: { sessionId, status: "error" } },
				)
				this.postStateToWebview().catch(() => {})
			},
		})
		this.sessionRebuilds = new SdkSessionRebuildScheduler({ sessions: this.sessions })
		this.taskHistory = new SdkTaskHistory({
			mcpHub: this.mcpHub,
			sessions: this.sessions,
			legacyExtensionStorageDir: this.context.globalStorageUri.fsPath,
			// History rendering mints ids from the shared authority so regenerated history ids
			// never overlap live-session ids.
			getMinter: () => this.messageTranslatorState.getMinter(),
		})
		// Every window reads the same sessions directory; when another one adds,
		// renames or deletes a conversation, refresh this window's history too.
		this.taskHistory.watchSessionChanges(() => {
			this.postStateToWebview().catch((error) => {
				Logger.warn("[SdkController] Failed to refresh state after a sessions change:", error)
			})
		})
		this.mode = new SdkModeCoordinator({
			stateManager: this.stateManager,
			sessions: this.sessions,
			interactions: this.interactions,
			messages: this.messages,
			sessionConfigBuilder: this.sessionConfigBuilder,
			getTask: () => this.task,
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			loadInitialMessages: async (sdkHost, sessionId) =>
				(await this.sessionHistory.loadInitialMessages(sdkHost, sessionId)) ?? [],
			buildStartSessionInput,
			resetMessageTranslator: () => this.resetMessageTranslatorAndFence(),
			postStateToWebview: () => this.postStateToWebview(),
			getTurnPhase: () => this.turnStateTracker.currentPhase,
			setTurnPhase: (phase, anchorTs) => this.turnStateTracker.set(phase, anchorTs),
			resolveContextMentions: (text) => this.resolveContextMentions(text),
			rebuilds: this.sessionRebuilds,
			onAutoContinueStarting: () => {
				this.turnStateTracker.set("streaming")
				this.messageTranslatorState.clearTurnOutcome()
			},
			onAutoContinueFailed: () => {
				this.turnStateTracker.set("error")
			},
		})
		this.mcpTools = new SdkMcpCoordinator({
			stateManager: this.stateManager,
			sessions: this.sessions,
			messages: this.messages,
			sessionConfigBuilder: this.sessionConfigBuilder,
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			loadInitialMessages: async (sdkHost, sessionId) =>
				(await this.sessionHistory.loadInitialMessages(sdkHost, sessionId)) ?? [],
			buildStartSessionInput,
			postStateToWebview: () => this.postStateToWebview(),
			rebuilds: this.sessionRebuilds,
		})
		this.terminalExecutionMode = new SdkTerminalExecutionModeCoordinator({
			stateManager: this.stateManager,
			sessions: this.sessions,
			messages: this.messages,
			sessionConfigBuilder: this.sessionConfigBuilder,
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			loadInitialMessages: async (sdkHost, sessionId) =>
				(await this.sessionHistory.loadInitialMessages(sdkHost, sessionId)) ?? [],
			buildStartSessionInput,
			postStateToWebview: () => this.postStateToWebview(),
			rebuilds: this.sessionRebuilds,
		})
		this.followups = new SdkFollowupCoordinator({
			stateManager: this.stateManager,
			interactions: this.interactions,
			sessions: this.sessions,
			messages: this.messages,
			taskHistory: this.taskHistory,
			sessionConfigBuilder: this.sessionConfigBuilder,
			waitForPendingRebuilds: async () => {
				await this.mode.waitForPendingRebuild()
				await this.sessionRebuilds.waitUntilSettled()
			},
			runExclusive: (operation) => this.sessionRebuilds.runExclusive(operation),
			getTask: () => this.task,
			createTempSessionHost: () => this.createTempSessionHost(),
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			loadInitialMessages: (sessionHost, taskId) => this.sessionHistory.loadInitialMessages(sessionHost, taskId),
			buildStartSessionInput,
			resolveContextMentions: (text) => this.resolveContextMentions(text),
			resetMessageTranslator: () => this.resetMessageTranslatorAndFence(),
			postStateToWebview: () => this.postStateToWebview(),
			onResumeFailed: () => {
				this.turnStateTracker.set("error")
			},
			onFollowUpAbandoned: () => {
				// Settle the streaming phase askResponse pre-set, unless a turn
				// (for example on the newly displayed task) has actually started.
				if (this.turnStateTracker.currentPhase === "streaming" && !this.sessions.getActiveSession()?.isRunning) {
					this.turnStateTracker.set("idle")
				}
			},
		})
		this.taskControl = new SdkTaskControlCoordinator({
			sessions: this.sessions,
			interactions: this.interactions,
			messages: this.messages,
			taskHistory: this.taskHistory,
			getTask: () => this.task,
			setTask: (task) => {
				this.task = task
			},
			onAskResponse: (text, images, files, delivery, options) => this.askResponse(text, images, files, delivery, options),
			resetMessageTranslator: () => this.resetMessageTranslatorAndFence(),
			// Bump the epoch synchronously before abort so straggler events from the cancelled
			// turn carry the old epoch and are dropped by the webview. The resumable phase is set
			// in SdkController.cancelTask before this runs.
			raiseCancelFence: () => {
				this.messageTranslatorState.clearApprovedToolMessageTs()
				this.messageTranslatorState.getMinter().bumpEpoch()
			},
			setTurnPhase: (phase, anchorTs) => this.turnStateTracker.set(phase, anchorTs),
			postStateToWebview: () => this.postStateToWebview(),
			clearTaskSettings: () => this.stateManager.clearTaskSettings(),
			onTaskEnded: () => this._terminalManager?.releaseIdleTerminals(),
			background: this.background,
			discardPreviews: () => this.diffEdits.discardAllPreviews("task moved to background"),
			onBackgroundLimitReached: () => {
				void HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: `PlinyCode already has ${MAX_BACKGROUND_SESSIONS} tasks running in the background, so the running task was stopped.`,
				})
			},
		})
		this.taskStart = new SdkTaskStartCoordinator({
			stateManager: this.stateManager,
			sessions: this.sessions,
			messages: this.messages,
			taskHistory: this.taskHistory,
			sessionConfigBuilder: this.sessionConfigBuilder,
			buildStartSessionInput,
			createHistoryItemFromSession,
			clearTask: async (options) => {
				this.activeTaskWorkspace = undefined
				await this.taskControl.clearTask(options)
			},
			setTask: (task) => {
				this.task = task
			},
			onAskResponse: (text, images, files, delivery, options) => this.askResponse(text, images, files, delivery, options),
			onCancelTask: () => this.cancelTask(),
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			getWindowWorkspace: () => this.getWindowWorkspace(),
			setActiveTaskWorkspace: (workspace, cwd) => {
				this.activeTaskWorkspace = { workspace, cwd }
				this.lastKnownWorkspaceRoot = cwd
			},
			onWorkspaceUsed: (workspace) => {
				if (workspace) {
					void this.recentWorkspaces.touch(workspace)
				}
			},
			createTempSessionHost: () => this.createTempSessionHost(),
			loadInitialMessages: (reader, taskId) => this.sessionHistory.loadInitialMessages(reader, taskId),
			resolveContextMentions: (text) => this.resolveContextMentions(text),
			postStateToWebview: () => this.postStateToWebview(),
			background: this.background,
			backgroundSessionsInFolder: (cwd) =>
				this.background.sessions().filter((session) => workspacePathsEqual(session.startConfig?.cwd, cwd)).length,
			createTaskWorktree: ({ folder, title }) =>
				ensureTaskWorktree({ repoRoot: folder, title, configuredRoot: configuredTaskWorktreeFolder() }),
		})
		this.compaction = new SdkCompactionCoordinator({
			stateManager: this.stateManager,
			sessions: this.sessions,
			rebuilds: this.sessionRebuilds,
			messages: this.messages,
			taskHistory: this.taskHistory,
			sessionConfigBuilder: this.sessionConfigBuilder,
			getDisplayedTaskId: () => this.task?.taskId,
			createTempSessionHost: () => this.createTempSessionHost(),
			loadInitialMessages: (reader, taskId) => this.sessionHistory.loadInitialMessages(reader, taskId),
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			postStateToWebview: () => this.postStateToWebview(),
		})
		this.sessionEvents = new SdkSessionEventCoordinator({
			messageTranslatorState: this.messageTranslatorState,
			sessions: this.sessions,
			messages: this.messages,
			taskHistory: this.taskHistory,
			getTask: () => this.task,
			postStateToWebview: () => this.postStateToWebview(),
			setTurnPhase: (phase, anchorTs) => this.turnStateTracker.set(phase, anchorTs),
			getTurnPhase: () => this.turnStateTracker.currentPhase,
			background: this.background,
		})
		this.checkpoints = new SdkCheckpointCoordinator({
			sessions: this.sessions,
			messages: this.messages,
			taskHistory: this.taskHistory,
			sessionConfigBuilder: this.sessionConfigBuilder,
			turnStateTracker: this.turnStateTracker,
			getTask: () => this.task,
			setTask: (task) => {
				this.task = task
			},
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			getMode: () => toMode(this.stateManager.getGlobalSettingsKey("mode")),
			createTempSessionHost: () => this.createTempSessionHost(),
			askResponse: (text, images, files) => this.askResponse(text, images, files),
			cancelTask: () => this.cancelTask(),
			resetMessageTranslatorAndFence: () => this.resetMessageTranslatorAndFence(),
			clearTurnOutcome: () => this.messageTranslatorState.clearTurnOutcome(),
			replaceMessages: (messages) => this.messages.replaceMessages(messages),
			postStateToWebview: () => this.postStateToWebview(),
			onCheckpointRestoreInput: (input) => {
				this.checkpointRestoreInput = input
			},
		})
		// Subscribe to MCP tool list changes so we can restart the SDK session
		// when servers are added/removed/reconnected. The SDK's DefaultSessionBuilder
		// does not support dynamic MCP tools, so we must restart the session.
		this.mcpHub.setToolListChangeCallback(() => this.mcpTools.handleToolListChanged())
		// Same for built-in servers (PlinyCode DevOps), which McpHub doesn't manage.
		this.unsubscribeBuiltinMcp = onBuiltinMcpToolsChanged(() => this.mcpTools.handleToolListChanged())

		// Initialize gRPC bridge
		this.grpcBridge = new WebviewGrpcBridge(this.messageTranslatorState)

		// Wire the bridge to the controller's getStateToPostToWebview()
		// so state updates include messages, currentTaskItem, and task history
		this.grpcBridge.setGetStateFn(() => this.getStateToPostToWebview())

		// Register the bridge as a session event listener
		this.onSessionEvent(this.grpcBridge.createListener())

		Logger.log("[SdkController] Initialized with SDK adapter layer + gRPC bridge")
	}

	getProviderConfigStore(): ProviderConfigStore {
		return this.providerConfigStore
	}

	getProviderCatalog(): ProviderCatalog {
		return this.providerCatalog
	}

	invalidateProviderListings(): void {
		this.providerCatalog.invalidateProviderListings()
	}

	private handleProviderConfigChange(event: ProviderConfigChange): void {
		this.scheduleProviderConfigStatePost()

		if (event.kind === "selection" && this.isSelectionForActiveModeProvider(event)) {
			// A CI board run stays on the model it was started with.
			const pinned = this.sessionConfigBuilder.pinnedModel(this.sessions?.getActiveSession()?.sessionId)
			if (pinned) {
				Logger.log(
					`[SdkController] The displayed conversation is pinned to ${pinned}; the new model applies to new tasks.`,
				)
				return
			}
			this.sessions
				?.updateActiveSessionModel(event.selection.modelId)
				.catch((error) => Logger.error("[SdkController] Failed to update active session model:", error))
		}
	}

	handleTerminalExecutionModeChanged(previous: VscodeTerminalExecutionMode, next: VscodeTerminalExecutionMode): void {
		this.terminalExecutionMode.handleTerminalExecutionModeChanged(previous, next)
	}

	/**
	 * The active Pliny API key changed. The provider reads its key once, when
	 * the session is built, so the idle session is rebuilt with the new one.
	 */
	handlePlinyApiKeyChanged(): void {
		this.terminalExecutionMode.handleProviderCredentialsChanged()
		void this.postStateToWebview()
	}

	private handleSessionBecameIdle(): void {
		this.sessionRebuilds?.sessionBecameIdle()
	}

	/**
	 * Runs before every foreground model call: pauses the conversation once it
	 * has spent its budget (see spending-limit.ts), and raises the budget by one
	 * step so the user can continue. Free models are never limited. Spend is
	 * measured the way the task header shows it.
	 */
	private async checkSpendingLimit(): Promise<AgentStopControl | undefined> {
		const task = this.task
		if (!task || this.isFreeModelSelected()) {
			return undefined
		}
		const spent = getConversationApiMetrics(task.messageStateHandler.getClineMessages()).totalCost
		const defaultBudget = getConversationSpendingLimit()
		const historyItem = await this.taskHistory.findHistoryItem(task.taskId)
		const hit = checkConversationBudget(
			spent,
			historyItem?.spendingLimit ?? defaultBudget,
			historyItem?.spendingStep ?? defaultBudget,
		)
		if (!hit) {
			return undefined
		}
		Logger.log(`[SdkController] Budget reached for ${task.taskId}: $${spent.toFixed(4)} of $${hit.budget}`)
		if (!(await this.taskHistory.setTaskSpendingLimit(task.taskId, hit.nextBudget, false))) {
			Logger.warn(`[SdkController] Could not raise the budget of ${task.taskId}; it is not in the task history`)
		}
		return this.interactions.handleSpendingLimitReached(hit)
	}

	/**
	 * The conversation budget, checked before each advisor call (sdk/advisor/).
	 * Unlike checkSpendingLimit it also applies on a free model and to a
	 * background task, and it refuses the call instead of pausing the run; see
	 * advisor-budget.ts. Returns why the call may not be made, or undefined.
	 * A background task has no chat rows; its history record has its cost.
	 */
	private checkAdvisorBudget(sessionId: string): Promise<string | undefined> {
		return checkAdvisorBudget(sessionId, {
			findHistoryItem: (id) => this.taskHistory.findHistoryItem(id),
			openTaskMessages: (id) =>
				this.task?.taskId === id && !this.background.has(id)
					? this.task.messageStateHandler.getClineMessages()
					: undefined,
			defaultBudget: getConversationSpendingLimit,
		})
	}

	/**
	 * The open task gets the cost of an advisor call or an image description
	 * from its usage row (the translator derives the advisor's from the tool
	 * result; the router emits the description's). A background task has no
	 * transcript until it is reopened, so its history record is updated here,
	 * like its model usage.
	 */
	private recordBackgroundExtraUsage(sessionId: string, usage: ModelCallUsage, source: "advisor" | "vision"): void {
		if (!this.background.has(sessionId)) {
			return
		}
		this.taskHistory
			.updateTaskUsage(
				sessionId,
				{
					tokensIn: usage.inputTokens,
					tokensOut: usage.outputTokens,
					cacheReads: usage.cacheReadTokens,
					cacheWrites: usage.cacheWriteTokens,
					totalCost: usage.totalCost,
				},
				source,
			)
			.catch((error) => Logger.error(`[SdkController] Failed to persist background ${source} usage:`, error))
	}

	/**
	 * The mode a session was started in: the displayed task's, or a background
	 * task's. A session's mode is fixed when its config is built (the mode
	 * switch rebuilds the displayed session), so it is the session's own and
	 * not the switch's current position.
	 */
	private sessionMode(sessionId: string): string | undefined {
		const active = this.sessions.getActiveSession()
		const session = active?.sessionId === sessionId ? active : this.background.session(sessionId)
		return session?.startConfig?.mode
	}

	/** True when the active mode's model costs nothing: a free self-hosted model or a FreeAuto router. */
	private isFreeModelSelected(): boolean {
		const mode = this.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"
		const apiConfig = this.stateManager.getApiConfiguration()
		return isPlinyFreeModelId(mode === "plan" ? apiConfig.planModeApiModelId : apiConfig.actModeApiModelId)
	}

	private isSelectionForActiveModeProvider(event: Extract<ProviderConfigChange, { kind: "selection" }>): boolean {
		try {
			const modeValue = this.stateManager.getGlobalSettingsKey("mode")
			const mode = modeValue === "plan" ? "plan" : "act"
			if (event.mode !== mode) {
				return false
			}

			const apiConfig = this.stateManager.getApiConfiguration()
			const activeProvider = mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider
			if (activeProvider === undefined) {
				return false
			}
			// A stale id in cached state reads as Pliny, so model-only commits
			// keep the lightweight in-session update path.
			return coerceToPlinyProvider(activeProvider) === event.providerId.toString()
		} catch {
			return false
		}
	}

	private scheduleProviderConfigStatePost(): void {
		if (this.providerConfigStatePostScheduled) {
			return
		}

		this.providerConfigStatePostScheduled = true
		queueMicrotask(() => {
			this.providerConfigStatePostScheduled = false
			this.postStateToWebview().catch((error) => {
				Logger.error("[SdkController] Failed to post state after provider config change:", error)
			})
		})
	}

	private createTempSessionHost(): Promise<VscodeSessionHost> {
		return VscodeSessionHost.create({ mcpHub: this.mcpHub })
	}

	/** @deprecated kept for API compatibility; delegates to the slash/mention resolver. */
	async invalidateUserInstructionService(): Promise<void> {
		await this.slashMentions.invalidateUserInstructionService()
	}

	async dispose(): Promise<void> {
		this.providerConfigStoreSubscription.dispose()
		this.isDisposed = true
		// Tear down the debounced state-post machinery before downstream resources
		// are disposed below — see StatePostDebouncer.dispose().
		await this.statePostDebouncer.dispose()
		await this.slashMentions.dispose()
		await this.memoryServices.search.dispose()
		this.messages.cancelPendingSave()
		// Clear MCP tool list change callback before disposing McpHub
		this.mcpHub?.clearToolListChangeCallback()
		this.unsubscribeBuiltinMcp?.()
		await this.diffEdits.discardAllPreviews("controller dispose")
		await this.clearTask()
		this.ciWatch.dispose()
		await this.background.stopAll("SdkController.dispose")
		await this.sessions.dispose("SdkController.dispose")
		this.diffEdits.dispose()
		// Child processes would outlive the window; terminals close with it.
		this.processesSubscription.dispose()
		await this.processes.killAll(undefined, (process) => process.source === "child")
		this._terminalManager?.disposeAll()
		await this.taskHistory.dispose()
		this.mcpHub?.dispose?.()
		this.messages.dispose()
		Logger.log("[SdkController] Disposed")
	}

	// ---- Slash command + context mention resolution ----
	// See sdk-slash-mention-resolver.ts for the implementation.

	/**
	 * Expand slash commands, then resolve `@` context mentions in user text
	 * before sending to the SDK.
	 */
	private async resolveContextMentions(text: string): Promise<string> {
		return this.slashMentions.resolveContextMentions(text)
	}

	// ---- Workspace root resolution ----
	// See sdk-workspace-root-resolver.ts for the implementation. Kept as thin
	// delegating methods here since they're referenced throughout this file and
	// by external callers (workspace/listRecentWorkspaces.ts, etc.) via the
	// Controller instance.

	/**
	 * Get the user's workspace root directory. Warms `lastKnownWorkspaceRoot`,
	 * the synchronous snapshot the message translator reads for display-path
	 * relativization.
	 */
	private async getWorkspaceRoot(): Promise<string> {
		return this.workspaceRootResolver.getWorkspaceRoot()
	}

	/**
	 * The workspace this window is open on: its folder, or its .code-workspace
	 * file when that lists several folders. Undefined in an empty window.
	 */
	async getWindowWorkspace(): Promise<WorkspaceRef | undefined> {
		return this.workspaceRootResolver.getWindowWorkspace()
	}

	/**
	 * Directory used when no workspace folder is open: the SDK's shared chat
	 * workspace, falling back to Desktop.
	 */
	private getNoWorkspaceFallback(): Promise<string> {
		return this.workspaceRootResolver.getNoWorkspaceFallback()
	}

	// ---- Session event subscription ----

	/**
	 * Subscribe to session events translated to ClineMessages.
	 * Returns an unsubscribe function.
	 */
	onSessionEvent(listener: SessionEventListener): () => void {
		return this.messages.onSessionEvent(listener)
	}

	/**
	 * Get the active API provider for the current mode.
	 */
	private getActiveProviderId(): string | undefined {
		try {
			const apiConfig = this.stateManager.getApiConfiguration()
			const modeValue = this.stateManager.getGlobalSettingsKey("mode")
			const mode = modeValue === "plan" ? "plan" : "act"
			return mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider
		} catch {
			return undefined
		}
	}

	private getTaskModelId(): string | undefined {
		const modelId = this.task?.api?.getModel?.().id?.trim()
		return modelId && modelId !== "unknown" ? modelId : undefined
	}

	private getSessionProviderId(sessionId?: string): string | undefined {
		const activeSession = this.sessions.getActiveSession()
		if (sessionId && activeSession?.sessionId !== sessionId) {
			return undefined
		}
		const providerId =
			activeSession?.startResult?.manifest?.provider?.trim() || activeSession?.startConfig?.providerId?.trim()
		return providerId && providerId !== "unknown" ? providerId : undefined
	}

	private getSessionModelId(sessionId?: string): string | undefined {
		const activeSession = this.sessions.getActiveSession()
		if (sessionId && activeSession?.sessionId !== sessionId) {
			return undefined
		}
		const modelId = activeSession?.startResult?.manifest?.model?.trim() || activeSession?.startConfig?.modelId?.trim()
		return modelId && modelId !== "unknown" ? modelId : undefined
	}

	/**
	 * Emit FreeAuto's end-of-turn summary (how many calls, which models, how
	 * long). No-op unless the turn ran on the router.
	 */
	private emitRouterTurnSummary(sessionId?: string): void {
		try {
			const modelId = this.getTaskModelId() ?? this.getSessionModelId(sessionId)
			if (!modelId) {
				return
			}
			emitTurnSummary(
				{
					sessionId: sessionId ?? this.sessions.getActiveSession()?.sessionId ?? "",
					getMode: () => (this.stateManager.getGlobalSettingsKey("mode") === "act" ? "act" : "plan"),
					emitRow: (msg) => this.messages.emitHookMessage(msg),
					nextMessageTs: () => this.messageTranslatorState.getMinter().nextId(),
				},
				modelId,
			)
		} catch (error) {
			Logger.warn("[SdkController] Failed to emit FreeAuto turn summary:" + String(error))
		}
	}

	// ---- Task lifecycle ----

	async initTask(
		prompt?: string,
		images?: string[],
		files?: string[],
		historyItem?: HistoryItem,
		taskSettings?: Partial<Settings>,
		workspace?: WorkspaceRef,
		options?: TaskStartOptions,
	): Promise<string | undefined> {
		// A new task is starting — the agent is about to stream.
		this.turnStateTracker.set("streaming")
		// Clear the previous turn's completion signal so this turn's phase is computed fresh.
		this.messageTranslatorState.clearTurnOutcome()
		return this.taskStart.initTask(prompt, images, files, historyItem, taskSettings, workspace, options)
	}

	/** Starting a task now would stop the running one: it is running and the background is full. */
	get startWouldStopRunningTask(): boolean {
		return Boolean(this.sessions.getActiveSession()?.isRunning) && this.background.isFull
	}

	/** Free background slots: a task started now in the background, or pushed there by a new task, takes one. */
	get backgroundFreeSlots(): number {
		return this.background.freeSlots
	}

	/**
	 * Starts a conversation straight into the background (a CI board auto-watch
	 * run), leaving the displayed task alone. Returns `full` when the
	 * background has no free slot.
	 */
	startBackgroundTask(
		prompt: string,
		workspace: WorkspaceRef | undefined,
		options: TaskStartOptions = {},
	): Promise<BackgroundStartResult> {
		return this.taskStart.startBackgroundTask(prompt, workspace, options)
	}

	/** Calls `listener` whenever a task leaves the background (finished, stopped or reopened). */
	onBackgroundTaskReleased(listener: (sessionId: string) => void): () => void {
		this.backgroundReleasedListeners.add(listener)
		return () => this.backgroundReleasedListeners.delete(listener)
	}

	/** Applies a CI board run's approval policy to its conversation. */
	setCiRunPolicy(conversationId: string, policy: CiRunPolicy): void {
		this.ciRunPolicies.set(conversationId, policy)
	}

	/**
	 * A CI board run's policy: the one set when it started, or, for a run from
	 * an earlier window, the guard rules rebuilt from the board's link.
	 */
	private ciRunPolicyFor(sessionId: string | undefined): CiRunPolicy | undefined {
		if (!sessionId) return undefined
		const own = this.ciRunPolicies.get(sessionId)
		if (own) return own
		const link = getCiBoard()?.linkOfConversation(sessionId)?.link
		if (!link?.sourceBranch || !link.remoteName) return undefined
		return {
			scope: "guard",
			worktree: link.worktree,
			remoteName: link.remoteName,
			sourceBranch: link.sourceBranch,
			readRoots: [],
		}
	}

	/** Where a conversation stands in this window: running on screen, running in the background, or neither. */
	conversationActivity(conversationId: string): "running" | "background" | "idle" {
		if (this.background.has(conversationId)) {
			return "background"
		}
		const active = this.sessions.getActiveSession()
		return active?.sessionId === conversationId && active.isRunning ? "running" : "idle"
	}

	async reinitExistingTaskFromId(taskId: string): Promise<void> {
		this.turnStateTracker.set("streaming")
		this.messageTranslatorState.clearTurnOutcome()
		await this.taskStart.reinitExistingTaskFromId(taskId)
	}

	async cancelTask(): Promise<void> {
		// Fence first: mark resumable before aborting so any straggler events from the aborted
		// turn land on the wrong side of the UI mode. (Full fence-before-abort epoch bump lands
		// in S6; this sets the authoritative phase now.)
		this.turnStateTracker.set("resumable")
		await this.taskControl.cancelTask()
	}

	/**
	 * Stop every running background process of the displayed conversation
	 * (the webview calls this on cancel and interrupt while its flag is set).
	 */
	async cancelBackgroundCommand(): Promise<void> {
		const taskId = this.activeTaskId
		if (!taskId) {
			return
		}
		const stopped = await this.processes.killAll(taskId)
		Logger.log(`[SdkController] cancelBackgroundCommand: stopped ${stopped} background process(es)`)
	}

	/**
	 * "Proceed While Running": detach every in-flight foreground terminal
	 * command. Each pending run_commands call returns its partial output plus
	 * the log file path the remaining output is redirected to, and the agent
	 * turn continues while the commands keep running in their terminals.
	 */
	async proceedWhileRunningCommand(): Promise<void> {
		const detached = this.foregroundCommands.proceedWhileRunning()
		if (detached === 0) {
			Logger.warn("[SdkController] proceedWhileRunningCommand: No foreground command is running")
		}
	}

	async cancelQueuedPrompt(promptId: string): Promise<void> {
		const trimmedPromptId = promptId.trim()
		if (!trimmedPromptId) {
			Logger.warn("[SdkController] cancelQueuedPrompt: Missing prompt id")
			return
		}

		const activeSession = this.sessions.getActiveSession()
		if (!activeSession) {
			Logger.warn("[SdkController] cancelQueuedPrompt: No active session")
			return
		}

		const result = await activeSession.sdkHost.pendingPrompts("delete", {
			sessionId: activeSession.sessionId,
			promptId: trimmedPromptId,
		})
		if (!result.removed) {
			Logger.warn(`[SdkController] cancelQueuedPrompt: Prompt not found: ${trimmedPromptId}`)
		}
		await this.postStateToWebview()
	}

	/**
	 * Manually compact (condense) the active task's conversation. Triggered by
	 * the compact button and the `/compact` (alias `/smol`) slash command.
	 * Mirrors the CLI's `/compact` local command: runs an SDK manual compaction
	 * and persists the compaction sidecar so the model's working context is
	 * reduced on the next turn and later resumes.
	 */
	async compactTask(): Promise<void> {
		await this.compaction.compactTask()
	}

	/**
	 * @param options.detachRunning Keep a running task going in the background
	 * (New Task). Other callers stop it.
	 */
	async clearTask(options: ClearTaskOptions = {}): Promise<void> {
		this.activeTaskWorkspace = undefined
		// No active task — UI returns to idle (input enabled, no buttons/thinking).
		this.turnStateTracker.set("idle")
		await this.taskControl.clearTask(options)
		await this.postStateToWebview()
	}

	async handleTaskCreation(prompt: string): Promise<void> {
		await this.initTask(prompt)
	}

	/**
	 * Send a follow-up message to the active session.
	 * This is the "askResponse" equivalent — continues the conversation.
	 *
	 * Like initTask(), this is fire-and-forget: core.send() blocks until
	 * the agent turn completes, but events stream in real-time via the
	 * subscription. We do NOT await the send — the gRPC handler needs to
	 * return immediately so the webview stays responsive.
	 */
	async askResponse(
		prompt?: string,
		images?: string[],
		files?: string[],
		delivery?: string,
		options?: FollowUpOptions,
	): Promise<void> {
		this.ciWatch.noteFollowUp(prompt, images, files)
		const turnStateBefore = this.turnStateTracker.get()

		// Answering an ask / continuing after completion / resuming a cancelled task all kick off a
		// new agent turn — move the authoritative phase to "streaming" so the footer shows
		// Thinking + Cancel (and not the stale resumable/completed/awaiting_followup buttons or the
		// scroll-arrow default). Mirrors initTask(). The webview gates turnState by seq, and the
		// session-event coordinator will set the terminal phase (completed/awaiting_followup/error)
		// when this turn ends.
		this.turnStateTracker.set("streaming")
		// Clear the previous turn's completion signal so this new turn's phase is computed fresh.
		this.messageTranslatorState.clearTurnOutcome()
		// The webview only learns the phase through a full state post. Without one here it would
		// keep the stale terminal phase (and hide the thinking indicator) until the first session
		// event of the new turn posts state — a visible delay after every follow-up/approval.
		this.postStateToWebview().catch((error) => {
			Logger.error("[SdkController] Failed to post state after askResponse phase change:", error)
		})
		await this.followups.askResponse(
			prompt,
			images,
			files,
			this.task?.taskState?.askResponse,
			turnStateBefore.phase,
			delivery as "queue" | "steer" | undefined,
			options,
		)
	}

	// ---- Task accessors (for gRPC handlers in core/controller/*) ----
	//
	// Handlers outside src/sdk/ should read/act on the displayed task through
	// these instead of poking at the TaskProxy's properties directly — the
	// TaskProxy shape is an internal implementation detail of the SDK adapter
	// layer (see task-proxy.ts).

	/** The id of the task currently displayed in the webview, if any. */
	get activeTaskId(): string | undefined {
		return this.task?.taskId
	}

	/** The displayed task's transcript, or an empty array when no task is active. */
	getActiveTaskMessages(): ClineMessage[] {
		return this.task?.messageStateHandler.getClineMessages() ?? []
	}

	/**
	 * Delivers a webview ask response (button click or follow-up message) to
	 * the displayed task. No-ops and returns false when no task is active.
	 */
	async sendTaskAskResponse(
		askResponse: ClineAskResponse,
		text?: string,
		images?: string[],
		files?: string[],
		delivery?: string,
		options?: FollowUpOptions,
	): Promise<boolean> {
		if (!this.task) {
			return false
		}
		await this.task.handleWebviewAskResponse(askResponse, text, images, files, delivery, options)
		return true
	}

	/**
	 * Points the displayed task's API handler at `modelId`. Used when a
	 * provider/model change is committed while a task is active. No-ops when
	 * no task is active.
	 */
	setActiveTaskModelId(modelId: string): void {
		if (!this.task) {
			return
		}
		this.task.api = createTaskApiModelShim(modelId)
	}

	/** Aborts the displayed task (without clearing it) — used by resetState. */
	abortActiveTask(): void {
		this.task?.abortTask()
	}

	/**
	 * Drops the displayed task without running the usual clearTask() teardown
	 * (session stop, workspace reset, state post) — used by resetState, which
	 * runs its own full extension-state reset around this.
	 */
	clearActiveTask(): void {
		this.task = undefined
	}

	async editMessageAndRegenerate(input: {
		messageTs: number
		text: string
		images?: string[]
		files?: string[]
		restoreWorkspace?: boolean
	}): Promise<void> {
		const editedText = input.text.trim()
		if (!editedText && (input.images?.length ?? 0) === 0 && (input.files?.length ?? 0) === 0) {
			throw new Error("Edited message cannot be empty")
		}

		const activeSession = this.sessions.getActiveSession()
		const currentTask = this.task
		if (!currentTask) {
			throw new Error("No active task to edit")
		}

		const clineMessages = currentTask.messageStateHandler.getClineMessages()
		const targetIndex = clineMessages.findIndex((message) => message.ts === input.messageTs)
		if (targetIndex === -1) {
			throw new Error("Message to edit was not found")
		}
		const targetMessage = clineMessages[targetIndex]
		if (targetMessage.type !== "say" || (targetMessage.say !== "task" && targetMessage.say !== "user_feedback")) {
			throw new Error("Only user messages can be edited")
		}

		const editedRow = describeEditedRow(clineMessages, targetIndex)
		const editsFirstPrompt = !editedRow.isAnswer && editedRow.promptOrdinal === 1
		const canRestoreWorkspace =
			!editedRow.isAnswer && getCheckpointRunCountForMessage(clineMessages, targetIndex) !== undefined
		if (input.restoreWorkspace && !canRestoreWorkspace) {
			throw new Error(
				"PlinyCode could not restore files for this message. Use a git workspace and edit a message that started an agent run with a checkpoint.",
			)
		}
		const sourceSessionId = activeSession?.sessionId ?? currentTask.taskId
		if (activeSession?.isRunning) {
			await this.cancelTask()
		}
		let sdkMessages: SdkUserMessage[]
		let tempHost: VscodeSessionHost | undefined
		const sessionHost = activeSession?.sdkHost ?? (tempHost = await this.createTempSessionHost())
		try {
			sdkMessages = (await sessionHost.readMessages(sourceSessionId)) as SdkUserMessage[]
			const restartPlan = planEditRestart(sdkMessages, editedRow)
			if (!restartPlan) {
				throw new Error("Could not map edited message to persisted conversation history")
			}
			const { checkpointRunCount, carriedRuns } = restartPlan

			const initialMessages = restartPlan.initialMessages as Parameters<VscodeSessionHost["start"]>[0]["initialMessages"]
			const firstUserMessage = sdkMessages.find(
				(message) => message.role === "user" && !!extractSdkUserText(message) && !isSyntheticSdkUserMessage(message),
			)
			const historyTitle = editsFirstPrompt
				? editedText
				: extractSdkUserText(firstUserMessage ?? {}) || clineMessages[0]?.text || editedText
			const fallbackCwd = await this.getWorkspaceRoot()
			const [sessionRecord, historyItem] = await Promise.all([
				sessionHost.get(sourceSessionId).catch(() => undefined),
				this.taskHistory.findHistoryItem(currentTask.taskId).catch(() => undefined),
			])
			const cwd =
				sessionRecord?.cwd?.trim() ||
				sessionRecord?.workspaceRoot?.trim() ||
				historyItem?.cwdOnTaskInitialization?.trim() ||
				fallbackCwd
			const mode = toMode(this.stateManager.getGlobalSettingsKey("mode"))
			const config = await this.sessionConfigBuilder.build({ cwd, mode, prompt: historyTitle })
			const resolvedPrompt = await this.resolveContextMentions(editedText)
			// Regenerating replaces the session: keep a user-given title and the
			// conversation's start and running time rather than resetting them.
			const displayTitle = historyItem?.isRenamed ? historyItem.task : historyTitle
			const carriedCheckpoint = carriedRuns > 0 ? createRestoredCheckpointMetadata(sessionRecord, carriedRuns) : undefined
			const carriedHistoryFields = {
				isFavorited: historyItem?.isFavorited,
				isPinned: historyItem?.isPinned,
				startedTs: historyItem?.startedTs,
				activeMs: historyItem?.activeMs,
				isRenamed: historyItem?.isRenamed,
				spendingLimit: historyItem?.spendingLimit,
				spendingStep: historyItem?.spendingStep,
			}
			const startInput = {
				...buildStartSessionInput(config, { prompt: historyTitle, cwd, mode }),
				initialMessages,
				sessionMetadata: {
					title: displayTitle,
					modelId: config.modelId,
					...(carriedHistoryFields.isFavorited ? { isFavorited: true } : {}),
					...(carriedHistoryFields.isPinned ? { isPinned: true } : {}),
					...(carriedHistoryFields.startedTs ? { startedTs: carriedHistoryFields.startedTs } : {}),
					...(carriedHistoryFields.activeMs ? { activeMs: carriedHistoryFields.activeMs } : {}),
					...(carriedHistoryFields.isRenamed ? { isRenamed: true } : {}),
					...(carriedHistoryFields.spendingLimit !== undefined
						? { spendingLimit: carriedHistoryFields.spendingLimit }
						: {}),
					...(carriedHistoryFields.spendingStep !== undefined
						? { spendingStep: carriedHistoryFields.spendingStep }
						: {}),
					// Only the checkpoints of runs before the edited message: the
					// regenerated run takes its own, so "View changes" and the reviewer
					// never diff against a snapshot from the abandoned turns.
					...(carriedCheckpoint ? { checkpoint: carriedCheckpoint } : {}),
				},
			}

			if (input.restoreWorkspace) {
				if (checkpointRunCount === undefined) {
					throw new Error(
						"PlinyCode could not restore files for this message. Use a git workspace and edit a message that started an agent run with a checkpoint.",
					)
				}
				try {
					await sessionHost.restore({
						sessionId: sourceSessionId,
						checkpointRunCount,
						cwd,
						restore: {
							messages: false,
							workspace: true,
							omitCheckpointMessageFromSession: true,
						},
					})
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error)
					throw new Error(`PlinyCode could not restore workspace files: ${detail}`)
				}
			}

			// The edit supersedes the old session — settle any pending tool
			// approval / ask_question exactly like cancelTask does. Without this,
			// the old run stays suspended forever on a promise nothing can
			// resolve, and the stale parked resolver intercepts later responses.
			this.interactions.clearPending("Superseded by an edited message")
			// Errors that show up late for files the abandoned turns edited belong
			// to those turns, not to the regenerated one's next edit result.
			this.diffEdits.forgetEditProblems()

			const { startResult, sdkHost } = await this.sessions.startNewSession(startInput)

			this.turnStateTracker.set("streaming")
			this.messageTranslatorState.clearTurnOutcome()
			this.resetMessageTranslatorAndFence()

			const task = createTaskProxy(
				startResult.sessionId,
				(text?: string, images?: string[], files?: string[]) => this.askResponse(text, images, files),
				() => this.cancelTask(),
			)
			this.task = task

			// Fill the new task's transcript now, before any await, and through the
			// coordinator so every row is stamped with the epoch the fence above just
			// opened. The webview drops rows from an older epoch, and unstamped ones
			// count as epoch 0: added unstamped after the awaits below, the kept rows
			// and the edited prompt were lost whenever a state post (or a stamped row)
			// reached the webview first, and the new turn's first request row, whose
			// text is "{}", then showed up as the conversation's prompt.
			const editedMessageTs = this.messageTranslatorState.getMinter().nextId()
			this.messages.replaceMessages([
				...clineMessages.slice(0, targetIndex).map((message) => ({ ...message })),
				{
					ts: editedMessageTs,
					type: "say",
					say: editsFirstPrompt ? "task" : "user_feedback",
					text: editedText,
					images: input.images,
					files: input.files,
					partial: false,
				},
			])
			this.editMessageRestartFocus = {
				messageTs: editedMessageTs,
				sessionId: startResult.sessionId,
			}

			const workspaceRoot =
				sessionRecord?.workspaceRoot?.trim() ||
				historyItem?.workspaceRootOnTaskInitialization?.trim() ||
				config.workspaceRoot?.trim() ||
				fallbackCwd
			const newHistoryItem = {
				...createHistoryItemFromSession(startResult.sessionId, displayTitle, config.modelId, cwd, workspaceRoot),
				...carriedHistoryFields,
			}
			if (sourceSessionId !== startResult.sessionId) {
				// Deleting the old session deletes its checkpoint refs; point refs of
				// the new session at the carried snapshots first so git keeps them.
				await retainCheckpointRefs(cwd, startResult.sessionId, carriedCheckpoint?.history ?? []).catch((error) =>
					Logger.warn(`[SdkController] Failed to keep checkpoints for ${startResult.sessionId}`, error),
				)
				this.ciWatch.manager.removeConversation(sourceSessionId)
				try {
					await this.taskHistory.deleteTaskFromState(sourceSessionId)
				} catch (error) {
					Logger.warn(`[SdkController] Failed to remove superseded session ${sourceSessionId} from history`, error)
				}
			}
			await this.taskHistory.updateTaskHistoryItem(newHistoryItem)
			await this.postStateToWebview()

			this.sessions.fireAndForgetSend(sdkHost, startResult.sessionId, resolvedPrompt, input.images, input.files)
		} finally {
			await tempHost?.dispose("editMessageAndRegenerate")
		}
	}

	// ---- Checkpoint restore and changes summary ----
	// See sdk-checkpoint-coordinator.ts for the implementation.

	async restoreCheckpoint(input: { checkpointRunCount: number; restoreType: ClineCheckpointRestore }): Promise<void> {
		return this.checkpoints.restoreCheckpoint(input)
	}

	async getCheckpointChangesSummary(input?: {
		checkpointRunCount?: number
		messageTs?: number
	}): Promise<LatestChangesSummary> {
		return this.checkpoints.getCheckpointChangesSummary(input)
	}

	async getLatestCheckpointChangesSummary(): Promise<LatestChangesSummary> {
		return this.checkpoints.getLatestCheckpointChangesSummary()
	}

	async openCheckpointFileDiff(filePath: string, checkpointRunCount: number): Promise<void> {
		return this.checkpoints.openCheckpointFileDiff(filePath, checkpointRunCount)
	}

	/**
	 * "View Changes" on the completion row: opens a multi-file diff of
	 * everything that changed between the latest checkpoint — snapshotted when
	 * the user's last message started this run — and the current working tree.
	 */
	async viewLatestCheckpointChanges(): Promise<void> {
		return this.checkpoints.viewLatestCheckpointChanges()
	}

	/**
	 * Show a task from history by loading its messages.
	 * This does NOT start inference — it just loads the task for viewing.
	 *
	 * IMPORTANT: We do NOT call clearTask() here because clearTask() sets
	 * this.task = undefined and may trigger async operations (session stop/dispose)
	 * that race with the new task proxy creation. If any of those async operations
	 * trigger postStateToWebview() while this.task is undefined, the webview
	 * receives a state with no currentTaskItem/clineMessages and flashes back
	 * to the welcome screen (S6-6/S6-23 fix).
	 *
	 * Instead, we:
	 * 1. Silently tear down the active session (unsubscribe + stop in background)
	 * 2. Create the new task proxy with loaded messages BEFORE any state push
	 * 3. Only then push state to the webview
	 *
	 * Delegates straight to the coordinator (including the history lookup) so
	 * the "latest selection wins" generation is allocated synchronously at the
	 * moment of the request — awaiting the lookup here first would let a
	 * stalled older request grab a NEWER generation than a later selection and
	 * replace it.
	 */
	async showTaskWithId(taskId: string): Promise<TaskResponse> {
		const historyItem = await this.taskControl.showTaskWithId(taskId)
		if (!historyItem) {
			throw new Error(`Task not found in history: ${taskId}`)
		}
		// A CI report that arrived while this conversation was not loaded is sent now.
		this.ciWatch.manager.conversationOpened(taskId)
		// Memories proposed in this conversation and not yet saved or dismissed.
		void this.memory.showPending(taskId)
		return historyItemToTaskResponse(historyItem)
	}

	/**
	 * The memory file of the displayed conversation's repository, or the
	 * user's own, created from the template when missing (docs/memory.md).
	 */
	async ensureMemoryFile(scope: "repo" | "user"): Promise<{ file: string; repo: string }> {
		const cwd = await this.getWorkspaceRoot()
		const file = await this.memoryServices.store.ensureFile(cwd, scope)
		const location = await this.memoryServices.store.locate(cwd)
		return { file, repo: location.repo.identity }
	}

	// ---- Mode switching ----

	async togglePlanActMode(modeToSwitchTo: Mode, chatContent?: ChatContent): Promise<boolean> {
		return this.mode.togglePlanActMode(modeToSwitchTo, chatContent)
	}

	async getTaskHistory(request: GetTaskHistoryRequest): Promise<TaskHistoryArray> {
		const { currentWorkspaceOnly } = request
		const limit = request.limit > 0 ? Math.min(request.limit, 100) : 50
		const offset = request.offset > 0 ? request.offset : 0
		// Conversations are bound to a workspace identity (docs/workspace-conversations.md).
		// "Current" is the window's; in an empty window it is the no-workspace chat
		// folder, which tasks started there record as their root.
		const workspacePath = currentWorkspaceOnly
			? ((await this.getWindowWorkspace())?.path ?? (await this.getNoWorkspaceFallback()))
			: request.workspacePath?.trim() || undefined
		const query: TaskHistoryQuery = {
			favoritesOnly: request.favoritesOnly,
			searchQuery: request.searchQuery,
			sortBy: request.sortBy,
			workspacePath,
			fromTs: request.fromTs,
			toTs: request.toTs,
		}
		// Filter the whole history and page the result. Paging first hid every
		// match older than the newest page, e.g. favorites from last month.
		// A search also matches message text through the conversation search
		// index, when SQLite is available (docs/conversation-history.md); a
		// .code-workspace binding has no single root to narrow the index query to.
		const contentMatches = query.searchQuery?.trim()
			? (this.memoryServices.search.searchContent(
					query.searchQuery,
					workspacePath && !workspacePath.toLowerCase().endsWith(".code-workspace") ? workspacePath : undefined,
				) ?? [])
			: []
		const { records: matching, snippets } = queryTaskHistoryWithContent(
			await this.taskHistory.listHistory({ hydrate: false }),
			query,
			contentMatches,
		)
		const hasMore = matching.length > offset + limit
		const tasks = matching.slice(offset, offset + limit).map((item) => {
			const metadata = item.metadata
			return {
				id: item.sessionId,
				task: formatDisplayUserInput(sessionRecordTitle(item)),
				ts: sessionRecordLastActiveTs(item),
				isFavorited: isSessionRecordFavorited(item),
				isPinned: isSessionRecordPinned(item),
				size: metadataNumber(metadata, "size") ?? 0,
				...readTaskUsageTotals(metadata),
				matchSnippet: snippets.get(item.sessionId) ?? "",
				...sessionHistoryRecordToTaskItemFields(item),
			}
		})

		// A conversation that just started may not be in the persisted history yet.
		const activeTask = this.task
		if (offset === 0 && activeTask?.taskId && !matching.some((item) => item.sessionId === activeTask.taskId)) {
			const taskMessage = activeTask.messageStateHandler
				.getClineMessages()
				.find((message) => message.type === "say" && message.say === "task" && message.text)
			const activeWorkspace = this.activeTaskWorkspace?.workspace
			const activeWorkspacePath = activeWorkspace?.path ?? (await this.getWorkspaceRoot())
			const startedTs = taskMessage?.ts || Date.now()
			if (
				taskMessage?.text &&
				taskHistoryRowMatches(
					{
						title: taskMessage.text,
						workspacePath: activeWorkspacePath,
						lastActiveTs: Date.now(),
						startedTs,
						isFavorited: false,
					},
					query,
				)
			) {
				// Below the pinned conversations, which lead the list.
				const firstUnpinned = tasks.findIndex((task) => !task.isPinned)
				tasks.splice(firstUnpinned === -1 ? tasks.length : firstUnpinned, 0, {
					id: activeTask.taskId,
					task: formatDisplayUserInput(taskMessage.text),
					ts: startedTs,
					isFavorited: false,
					isPinned: false,
					size: 0,
					totalCost: 0,
					tokensIn: 0,
					tokensOut: 0,
					cacheWrites: 0,
					cacheReads: 0,
					modelId: activeTask.api?.getModel?.().id ?? "",
					apiProvider: "",
					workspaceRoot: await this.getWorkspaceRoot(),
					workspacePath: activeWorkspacePath,
					workspaceKind: activeWorkspace?.kind ?? "folder",
					isLegacy: false,
					startedTs: taskMessage.ts || 0,
					activeMs: 0,
					matchSnippet: "",
					worktreeBranch: "",
				})
			}
		}

		return TaskHistoryArray.create({ tasks: tasks.slice(0, limit), hasMore })
	}

	async exportTaskWithId(id: string): Promise<void> {
		const taskDirPath = await this.taskHistory.getTaskDirPath(id)
		if (!taskDirPath) {
			throw new Error(`Task not found in history: ${id}`)
		}

		await fs.access(taskDirPath)
		Logger.log(`[EXPORT] Opening task directory: ${taskDirPath}`)
		const open = (await import("open")).default
		await open(taskDirPath)
	}

	/**
	 * Render a task's conversation as Markdown and write it where the user picks.
	 *
	 * Works for the active task and for history tasks with no live session
	 * (legacy imports included): messages come from the in-memory message state
	 * when the id is the running task, and from the history loader otherwise.
	 *
	 * @returns the written path, or undefined when the save dialog was cancelled.
	 */
	/**
	 * The conversation as the Markdown export renders it, without saving it:
	 * the export command writes it where the user chooses, the diagnostics
	 * bundle puts it in its folder.
	 */
	async renderTaskMarkdown(
		taskId: string,
		options: { includeToolOutput?: boolean; includeReasoning?: boolean } = {},
	): Promise<{ markdown: string; historyItem: HistoryItem }> {
		const id = taskId?.trim() || this.task?.taskId
		if (!id) {
			throw new Error("No task to export")
		}

		const isActiveTask = this.task?.taskId === id
		const messages = isActiveTask
			? (this.task?.messageStateHandler.getClineMessages() ?? [])
			: await this.taskHistory.getClineMessages(id)

		let historyItem = await this.taskHistory.findHistoryItem(id)
		if (!historyItem) {
			if (!isActiveTask) {
				throw new Error(`Task not found in history: ${id}`)
			}
			// A just-started task may not be in persisted history yet; synthesize
			// the header from the live session so the export still works.
			const taskMessage = messages.find((message) => message.type === "say" && message.say === "task")
			historyItem = {
				id,
				ts: taskMessage?.ts ?? Date.now(),
				task: taskMessage?.text ?? "",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				modelId: this.task?.api?.getModel?.().id,
				cwdOnTaskInitialization: await this.getWorkspaceRoot(),
			}
		}

		const markdown = renderConversationMarkdown(historyItem, messages, {
			includeToolOutput: options.includeToolOutput ?? true,
			includeReasoning: options.includeReasoning ?? false,
			plinyCodeVersion: ExtensionRegistryInfo.version,
		})
		return { markdown, historyItem }
	}

	async exportTaskToMarkdown(
		taskId: string,
		options: { includeToolOutput?: boolean; includeReasoning?: boolean } = {},
	): Promise<string | undefined> {
		const { markdown, historyItem } = await this.renderTaskMarkdown(taskId, options)
		return saveMarkdownExport(markdown, {
			defaultDirectory: historyItem.cwdOnTaskInitialization || (await this.getWorkspaceRoot()),
			defaultFilename: defaultMarkdownExportFilename(historyItem.ts),
		})
	}

	async deleteTaskFromState(id: string): Promise<HistoryItem[]> {
		await this.background.stopTask(id, "task deleted")
		this.ciWatch.manager.removeConversation(id)
		return this.taskHistory.deleteTaskFromState(id)
	}

	async deleteAllTaskHistory(): Promise<DeleteAllTaskHistoryCount> {
		await this.clearTask()

		const taskHistory = await this.taskHistory.listHistory({ hydrate: false })
		const totalTasks = taskHistory.length

		const userChoice = (
			await HostProvider.window.showMessage(
				ShowMessageRequest.create({
					type: ShowMessageType.WARNING,
					message: "What would you like to delete?",
					options: {
						modal: true,
						items: ["Delete All Except Favorites", "Delete Everything"],
					},
				}),
			)
		).selectedOption

		if (userChoice === undefined) {
			return DeleteAllTaskHistoryCount.create({ tasksDeleted: 0 })
		}
		await this.background.stopAll("task history deleted")
		this.ciWatch.manager.clear()

		if (userChoice === "Delete All Except Favorites") {
			const hasFavoritedTasks = taskHistory.some(
				(task) =>
					metadataBoolean(task.metadata, "isFavorited") ?? metadataBoolean(task.metadata, "is_favorited") ?? false,
			)

			if (hasFavoritedTasks) {
				const tasksDeleted = await this.taskHistory.deleteAllTaskHistory({
					preserveFavorites: true,
				})
				await this.postStateToWebview()
				return DeleteAllTaskHistoryCount.create({ tasksDeleted })
			}

			const answer = (
				await HostProvider.window.showMessage({
					type: ShowMessageType.WARNING,
					message: "No favorited tasks found. Would you like to delete all tasks anyway?",
					options: {
						modal: true,
						items: ["Delete All Tasks"],
					},
				})
			).selectedOption

			if (answer === undefined) {
				return DeleteAllTaskHistoryCount.create({ tasksDeleted: 0 })
			}
		}

		const tasksDeleted = await this.taskHistory.deleteAllTaskHistory()
		await this.postStateToWebview()
		return DeleteAllTaskHistoryCount.create({
			tasksDeleted: tasksDeleted || totalTasks,
		})
	}

	async updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]> {
		return this.taskHistory.updateTaskHistory(item)
	}

	async toggleTaskFavorite(taskId: string, isFavorited: boolean): Promise<void> {
		if (!(await this.taskHistory.setTaskFavorite(taskId, isFavorited))) {
			Logger.log(`[toggleTaskFavorite] Task not found in history: ${taskId}`)
			return
		}
		await this.postStateToWebview()
	}

	/** The git worktree a conversation started with "Run in worktree" works in; undefined for any other. */
	async getTaskWorktree(taskId: string): Promise<TaskWorktree | undefined> {
		return (await this.taskHistory.findHistoryItem(taskId))?.worktree
	}

	/** The conversation's history entry; undefined for an unknown one. */
	async getHistoryItem(taskId: string): Promise<HistoryItem | undefined> {
		return this.taskHistory.findHistoryItem(taskId)
	}

	/** Replaces the conversation's worktree record (e.g. marks it removed) and refreshes the task header. */
	async setTaskWorktree(taskId: string, worktree: TaskWorktree): Promise<void> {
		if (await this.taskHistory.setTaskWorktree(taskId, worktree)) {
			await this.postStateToWebview()
		}
	}

	/**
	 * Every conversation's id, title, last activity and worktree, for the
	 * worktree cleanup and the Manage Worktrees list (docs/task-worktrees.md).
	 */
	async listConversationWorktrees(): Promise<WorktreeConversation[]> {
		return (await this.taskHistory.listHistory({ hydrate: false })).map((record) => {
			const worktree = metadataWorktree(record.metadata)
			return {
				id: record.sessionId,
				title: sessionRecordTitle(record),
				ts: sessionRecordLastActiveTs(record),
				...(worktree ? { worktree } : {}),
			}
		})
	}

	/** Adds an info row to the conversation's chat, when it is the one on screen. */
	emitInfoRow(taskId: string, text: string): void {
		if (this.task?.taskId !== taskId) {
			return
		}
		this.messages.emitHookMessage({
			ts: this.messageTranslatorState.getMinter().nextId(),
			type: "say",
			say: "info",
			text,
			partial: false,
		})
	}

	/** Pins the conversation to the top of the history list, or unpins it. */
	async toggleTaskPin(taskId: string, isPinned: boolean): Promise<void> {
		if (!(await this.taskHistory.setTaskPinned(taskId, isPinned))) {
			Logger.log(`[toggleTaskPin] Task not found in history: ${taskId}`)
			return
		}
		await this.postStateToWebview()
	}

	async renameTask(taskId: string, title: string): Promise<void> {
		if (!(await this.taskHistory.renameTask(taskId, title))) {
			Logger.log(`[renameTask] Task not found in history or blank title: ${taskId}`)
			return
		}
		await this.postStateToWebview()
	}

	/** Sets a conversation's budget in USD (0 = no limit); the next model call checks against it. */
	async setTaskSpendingLimit(taskId: string, limit: number): Promise<void> {
		if (!(await this.taskHistory.setTaskSpendingLimit(taskId, limit))) {
			Logger.log(`[setTaskSpendingLimit] Task not found in history or invalid amount: ${taskId} ${limit}`)
			return
		}
		await this.postStateToWebview()
	}

	// ---- State management ----

	/**
	 * Request a webview state update.
	 *
	 * Callers fire this very frequently (notably the session event coordinator,
	 * once per streamed message/turn boundary), and each rebuild walks the full
	 * task history. StatePostDebouncer coalesces bursts into a single trailing
	 * rebuild to avoid hammering the extension host. The returned promise
	 * resolves once a snapshot reflecting this request has been shipped, or
	 * rejects if that rebuild failed.
	 */
	postStateToWebview(): Promise<void> {
		if (this.isDisposed) {
			return Promise.resolve()
		}
		return this.statePostDebouncer.post()
	}

	/** Build the current ExtensionState and push it to the webview immediately. */
	private async flushStateToWebview(): Promise<void> {
		// Import dynamically to avoid circular deps
		const { sendStateUpdate } = await import("@core/controller/state/subscribeToState")
		const state = await this.getStateToPostToWebview()
		await sendStateUpdate(state)
	}

	/**
	 * Reset the message translator's streaming state AND bump the conversation/replica fence
	 * (epoch). Called at every conversation boundary (task start/clear, history open, reinit,
	 * mode rebuild, new-session follow-up). Bumping the epoch BEFORE the new state is pushed
	 * means any straggler message/state from the previous task or render carries an older epoch
	 * and is dropped by the webview. Order matters: bump synchronously here, before any await.
	 */
	resetMessageTranslatorAndFence(): void {
		this.messageTranslatorState.reset()
		this.messageTranslatorState.getMinter().bumpEpoch()
		// Every follow-up passes through here too, so the sub-agents' transcripts go
		// only when the conversation itself changed (opened, cleared, resumed).
		const taskId = this.task?.taskId
		if (taskId !== this.subagentTranscriptsTaskId) {
			this.subagentTranscriptsTaskId = taskId
			this.messageTranslatorState.clearSubagentTranscripts()
		}
	}

	/** The open conversation's live sub-agent transcripts (TaskService.subscribeToSubagentMessages). */
	getSubagentTranscripts(): SubagentTranscripts {
		return this.messageTranslatorState.getSubagentTranscripts()
	}

	/**
	 * Build the ExtensionState to push to the webview: the base state (settings,
	 * toggles, the active task's messages — see getStateToPostToWebview.ts) with
	 * the SDK's task history, current task item, turn state, queued prompts and
	 * background tasks layered on top by mergeTaskHistoryIntoState.
	 */
	async getStateToPostToWebview(): Promise<ExtensionState> {
		try {
			const { getStateToPostToWebview: buildBaseState } = await import("@core/controller/state/getStateToPostToWebview")
			// The transcript and its epoch are read together, with no await between
			// them: an epoch read after the awaits below could belong to a newer
			// task or restart than the transcript, and the webview would take an
			// old transcript as the new one (or an empty one, dropping the new rows).
			const minter = this.messageTranslatorState.getMinter()
			const activeTaskMessages = this.getActiveTaskMessages()
			const epoch = minter.epoch
			const backgroundCommandRunning = this.activeTaskId !== undefined && this.processes.hasRunning(this.activeTaskId)
			const baseState = await buildBaseState({
				activeTaskId: this.activeTaskId,
				activeTaskMessages,
				stateManager: this.stateManager,
				mcpHub: this.mcpHub,
				backgroundCommandRunning,
				backgroundCommandTaskId: backgroundCommandRunning ? this.activeTaskId : undefined,
				foregroundCommandRunning: this.foregroundCommands.isRunning,
				// Without this the webview always receives workspaceRoots: [] on the
				// SDK path (classic Controller exposes a public workspaceManager;
				// SdkController builds one lazily). The task-header working-directory
				// badge and anything else keyed on workspaceRoots depend on it.
				workspaceManager: await this.ensureWorkspaceManager(),
			})

			let queuedPrompts: ExtensionState["queuedPrompts"] = []
			const activeSession = this.sessions.getActiveSession()
			if (activeSession) {
				try {
					const pending = await activeSession.sdkHost.pendingPrompts("list", { sessionId: activeSession.sessionId })
					// The queue shows what the user typed, without the model-only elements attached on send.
					queuedPrompts = pending.map((queued) => ({ ...queued, prompt: stripModeNotices(queued.prompt) }))
				} catch (error) {
					Logger.error("[SdkController] Failed to list pending prompts for webview state:", error)
				}
			}

			// Stamp the snapshot with the transcript's epoch and a fresh monotonic version from
			// the SAME counter that stamps messages. This lets the webview ignore stale
			// out-of-order state pushes and fence traffic from a previous task/render.
			return await mergeTaskHistoryIntoState({
				baseState,
				taskHistory: this.taskHistory,
				task: this.task,
				getWorkspaceRoot: () => this.getWorkspaceRoot(),
				getWindowWorkspace: () => this.getWindowWorkspace(),
				activeTaskWorkspace: this.activeTaskWorkspace,
				turnState: this.turnStateTracker.get(),
				queuedPrompts,
				backgroundTasks: this.background.list(),
				activeSession,
				stateVersion: minter.nextSeq(),
				epoch,
			})
		} catch (error) {
			Logger.error("[SdkController] Failed to get state for webview:", error)
			throw error
		}
	}

	// ---- Terminal settings ----

	/**
	 * Apply the user's terminal settings from StateManager to a terminal manager.
	 * Called once when the lazy terminal manager is first created, and can be
	 * called again when settings change at runtime.
	 */
	applyTerminalSettings(terminalManager: VscodeTerminalManager): void {
		const shellIntegrationTimeout = this.stateManager.getGlobalSettingsKey("shellIntegrationTimeout")
		if (shellIntegrationTimeout !== undefined) {
			terminalManager.setShellIntegrationTimeout(Number(shellIntegrationTimeout))
		}

		const terminalReuseEnabled = this.stateManager.getGlobalStateKey("terminalReuseEnabled")
		if (terminalReuseEnabled !== undefined) {
			terminalManager.setTerminalReuseEnabled(!!terminalReuseEnabled)
		}

		const defaultTerminalProfile = this.stateManager.getGlobalSettingsKey("defaultTerminalProfile")
		if (defaultTerminalProfile !== undefined && defaultTerminalProfile !== "") {
			terminalManager.setDefaultTerminalProfile(String(defaultTerminalProfile))
		}

		Logger.log(
			`[SdkController] Applied terminal settings: profile=${defaultTerminalProfile ?? "default"}, ` +
				`timeout=${shellIntegrationTimeout ?? 4000}, reuse=${terminalReuseEnabled ?? true}`,
		)
	}

	/**
	 * Get the terminal manager instance (if created).
	 * Used by updateSettings handlers to apply runtime changes.
	 */
	get terminalManager(): VscodeTerminalManager | undefined {
		return this._terminalManager
	}

	// ---- Workspace (kept from classic) ----
	// See sdk-workspace-root-resolver.ts for the implementation.

	async ensureWorkspaceManager(): Promise<WorkspaceRootManager | undefined> {
		return this.workspaceRootResolver.ensureWorkspaceManager(this.lastKnownWorkspaceRoot)
	}
}
