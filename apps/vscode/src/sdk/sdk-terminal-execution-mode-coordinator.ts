import type { ClineMessage } from "@shared/ExtensionMessage"
import { type Mode, toMode } from "@shared/storage/types"
import type { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"
import type { SdkMessageCoordinator } from "./sdk-message-coordinator"
import type { SdkSessionConfigBuilder } from "./sdk-session-config-builder"
import type { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import type { SdkSessionRebuildScheduler, SessionRebuildReason } from "./sdk-session-rebuild-scheduler"
import type { SdkSessionHost } from "./session-host"
import type { VscodeSessionHost } from "./vscode-session-host"
import type { VscodeTerminalExecutionMode } from "./vscode-terminal-execution-mode"

type StartInput = Parameters<VscodeSessionHost["start"]>[0]
type InitialMessages = StartInput["initialMessages"]
type SessionConfig = Awaited<ReturnType<SdkSessionConfigBuilder["build"]>>

export interface SdkTerminalExecutionModeCoordinatorOptions {
	stateManager: StateManager
	sessions: SdkSessionLifecycle
	messages: SdkMessageCoordinator
	sessionConfigBuilder: SdkSessionConfigBuilder
	getWorkspaceRoot: () => Promise<string>
	loadInitialMessages: (sdkHost: SdkSessionHost, sessionId: string) => Promise<unknown[] | undefined>
	buildStartSessionInput: (config: SessionConfig, input: { cwd: string; mode: Mode }) => StartInput
	postStateToWebview: () => Promise<void>
	rebuilds: Pick<SdkSessionRebuildScheduler, "request">
}

/** What a restart is for: the label its log lines use, and what to tell the user when it fails. */
interface RestartKind {
	reason: SessionRebuildReason
	label: string
	disposeReason: string
	failureText: (message: string) => string
}

const TERMINAL_EXECUTION_MODE: RestartKind = {
	reason: "terminalExecutionMode",
	label: "terminal execution mode",
	disposeReason: "terminalExecutionModeChange",
	failureText: (message) =>
		`Failed to reload terminal tools: ${message}. Terminal timeout changes may not apply until the next task.`,
}

const PROVIDER_CREDENTIALS: RestartKind = {
	reason: "providerCredentials",
	label: "Pliny API key",
	disposeReason: "providerCredentialsChange",
	failureText: (message) => `Failed to switch the Pliny API key: ${message}. The new key applies from the next task.`,
}

const MODEL_TUNING: RestartKind = {
	reason: "modelTuning",
	label: "model tuning",
	disposeReason: "modelTuningChange",
	failureText: (message) => `Failed to apply the model tuning: ${message}. It applies from the next task.`,
}

/**
 * Restarts the idle session, keeping its conversation, when something it
 * captured at build time changes: the terminal execution mode (its tools and
 * their timeout), the Pliny API key (the provider reads it once, when
 * created) or the model's tuning (reasoning and context budget).
 */
export class SdkTerminalExecutionModeCoordinator {
	constructor(private readonly options: SdkTerminalExecutionModeCoordinatorOptions) {}

	handleTerminalExecutionModeChanged(previous: VscodeTerminalExecutionMode, next: VscodeTerminalExecutionMode): void {
		if (previous === next) {
			return
		}
		this.requestRebuild(TERMINAL_EXECUTION_MODE, `Terminal execution mode changed: ${previous} -> ${next}`)
	}

	/** The active Pliny API key changed (in Settings, here or in another window). */
	handleProviderCredentialsChanged(): void {
		this.requestRebuild(PROVIDER_CREDENTIALS, "Pliny API key changed")
	}

	/** The reasoning or context tuning of the session's model changed. */
	handleModelTuningChanged(): void {
		this.requestRebuild(MODEL_TUNING, "Model tuning changed")
	}

	private requestRebuild(kind: RestartKind, reason: string): void {
		Logger.log(`[SdkController] ${reason}`)

		const activeSession = this.options.sessions.getActiveSession()
		if (!activeSession) {
			Logger.log(`[SdkController] No active session - the new ${kind.label} will be picked up on next initTask`)
			return
		}

		this.options.rebuilds.request(kind.reason, () => this.restartSession(kind))
	}

	async restartSessionForTerminalExecutionMode(): Promise<void> {
		await this.restartSession(TERMINAL_EXECUTION_MODE)
	}

	private async restartSession(kind: RestartKind): Promise<void> {
		const activeSession = this.options.sessions.getActiveSession()
		if (!activeSession) {
			return
		}

		const { sdkHost: oldManager, sessionId: oldSessionId } = activeSession

		Logger.log(`[SdkController] Restarting session ${oldSessionId} for ${kind.label}`)

		this.options.messages.emitSessionEvents([], {
			type: "status",
			payload: { sessionId: oldSessionId, status: "running" },
		})

		try {
			const cwd = await this.options.getWorkspaceRoot()
			const mode = toMode(this.options.stateManager.getGlobalSettingsKey("mode"))
			const config = await this.options.sessionConfigBuilder.build({ cwd, mode })
			config.sessionId = oldSessionId

			const initialMessages = await this.options.loadInitialMessages(oldManager, oldSessionId)
			const startInput = this.options.buildStartSessionInput(config, { cwd, mode })

			// Rebuilds may preserve the session ID, so identity is the only reliable
			// way to detect that another path replaced this session while we awaited.
			const currentSession = this.options.sessions.getActiveSession()
			if (!currentSession) {
				Logger.log(`[SdkController] Active session changed during ${kind.label} restart (was ${oldSessionId}); aborting`)
				return
			}
			if (currentSession !== activeSession || currentSession.isRunning) {
				Logger.log(
					`[SdkController] Active session changed or started running during ${kind.label} restart (was ${oldSessionId}); deferring`,
				)
				this.options.rebuilds.request(kind.reason, () => this.restartSession(kind))
				return
			}

			const restartResult = await this.options.sessions.replaceActiveSession({
				expectedSession: activeSession,
				startInput,
				initialMessages: initialMessages as InitialMessages,
				disposeReason: kind.disposeReason,
			})
			if (!restartResult) {
				return
			}

			const { startResult } = restartResult
			if (startResult.sessionId !== oldSessionId) {
				Logger.warn(
					`[SdkController] ${kind.label} restart returned a new session ID (${startResult.sessionId}); preserving task ID ${oldSessionId} for UI continuity`,
				)
			}

			this.options.messages.emitSessionEvents([], {
				type: "status",
				payload: { sessionId: startResult.sessionId, status: "idle" },
			})

			await this.options.postStateToWebview()
			Logger.log(`[SdkController] Session restarted for ${kind.label}: ${oldSessionId} -> ${startResult.sessionId}`)
		} catch (error) {
			Logger.error(`[SdkController] Failed to restart session for ${kind.label}:`, error)

			const errorMessage: ClineMessage = {
				ts: Date.now(),
				type: "say",
				say: "error",
				text: kind.failureText(error instanceof Error ? error.message : String(error)),
				partial: false,
			}
			this.options.messages.appendAndEmit([errorMessage], {
				type: "status",
				payload: { sessionId: oldSessionId, status: "error" },
			})
			await this.options.postStateToWebview()
		}
	}
}
