import type { CoreSessionEvent, RestoreInput, RestoreResult, StartSessionResult } from "@plinycode/core"
import { formatModeSwitchNotice, type ModeSwitchNotice } from "@plinycode/shared"
import { StateManager } from "@/core/storage/StateManager"
import type { VscodeTerminalManager } from "@/hosts/vscode/terminal/VscodeTerminalManager"
import { McpHub } from "@/services/mcp/McpHub"
import { Logger } from "@/shared/services/Logger"
import type { ActiveSession } from "./cline-session-factory"
import type { ConversationEditorState } from "./context/editor-state"
import { forgetSession } from "./router/router-health"
import type { SdkForegroundCommandCoordinator } from "./sdk-foreground-command-coordinator"
import { buildToolPolicies } from "./sdk-tool-policies"
import { isSyntheticUserPrompt } from "./sdk-user-message-mapping"
import type { SdkSessionHost } from "./session-host"
import { VscodeSessionHost } from "./vscode-session-host"

type RequestToolApprovalHandler = NonNullable<Parameters<typeof VscodeSessionHost.create>[0]["requestToolApproval"]>
type AskQuestionHandler = NonNullable<Parameters<typeof VscodeSessionHost.create>[0]["askQuestion"]>
type EditorExecutorHandler = NonNullable<Parameters<typeof VscodeSessionHost.create>[0]["editorExecutor"]>
type ApplyPatchExecutorHandler = NonNullable<Parameters<typeof VscodeSessionHost.create>[0]["applyPatchExecutor"]>
type ReadFileExecutorHandler = NonNullable<Parameters<typeof VscodeSessionHost.create>[0]["readFileExecutor"]>

interface SdkSessionLifecycleOptions {
	mcpHub: McpHub
	requestToolApproval: RequestToolApprovalHandler
	askQuestion: AskQuestionHandler
	/** Custom `editor` executor (diff-view edit pipeline); replaces the SDK's disk writer. */
	editorExecutor?: EditorExecutorHandler
	/** Custom `apply_patch` executor (reverts the diff preview, then applies via the SDK default). */
	applyPatchExecutor?: ApplyPatchExecutorHandler
	/** Custom `read_files` executor (resolves relative paths against the workspace root). */
	readFileExecutor?: ReadFileExecutorHandler
	onSessionEvent: (event: CoreSessionEvent) => void
	/** Lazy factory for the VscodeTerminalManager (foreground terminal support). */
	getTerminalManager?: () => VscodeTerminalManager
	/** Registry of in-flight foreground executions for "Proceed While Running". */
	foregroundCommands?: SdkForegroundCommandCoordinator
	onSendStart?: (sessionId: string) => void
	onSendComplete: (sessionId: string) => Promise<void> | void
	onSendError: (error: unknown, sessionId: string) => Promise<void> | void
	/**
	 * Returns (and clears) a pending user-initiated plan/act switch recorded by
	 * SdkModeCoordinator for this session, so fireAndForgetSend — the single
	 * funnel for outbound turn sends — can stamp a <mode_notice> onto the next
	 * message. Consumed exactly once; null when no switch is pending.
	 */
	consumeModeSwitchNotice?: (sessionId: string) => ModeSwitchNotice | null
	onDidBecomeIdle?: () => void
	/** A foreground run ended after `elapsedMs`; feeds the task's accumulated running time. */
	onRunElapsed?: (sessionId: string, elapsedMs: number) => void
	/**
	 * A send settled after its session left the foreground (it now runs in the
	 * background). The background registry treats it as a turn end.
	 */
	onDetachedSendSettled?: (sessionId: string, error?: unknown) => void
	/**
	 * Metadata to store with a session's record whenever that session starts.
	 * Carries the conversation's git snapshot (context/conversation-git-snapshots.ts),
	 * so the engine persists it with the record and a later resume finds it.
	 */
	getSessionStartMetadata?: (sessionId: string | undefined) => Record<string, unknown> | undefined
	/**
	 * Editor state appended to the messages the user types
	 * (context/editor-state.ts). Not consulted for prompts the extension
	 * writes itself (task resumption, the plan -> act continuation).
	 */
	editorState?: Pick<ConversationEditorState, "nextBlock" | "syncWithTranscript">
}

export class SdkSessionLifecycle {
	private activeSession: ActiveSession | undefined
	private sharedHost: SdkSessionHost | undefined
	private sharedHostPromise: Promise<SdkSessionHost> | undefined
	private sharedHostUnsubscribe: (() => void) | undefined
	/**
	 * Stops still in flight, keyed by sessionId. Mode/MCP rebuilds and
	 * follow-up resumes reuse the sessionId of the session they replace, and
	 * core cleanup is keyed by sessionId, so a same-id start that overlaps a
	 * stop would be torn down by the old session's late cleanup.
	 * startNewSession consults this map to enforce stop-before-start, the same
	 * sequencing the CLI uses.
	 */
	private readonly pendingStops = new Map<string, Promise<void>>()
	/** Orders the sends that wait on the editor state; see fireAndForgetSend. */
	private outboundSends: Promise<void> = Promise.resolve()
	/** Set while an off-the-record send's turn runs; the token is that send's own. */
	private offTheRecordTurn: object | undefined

	constructor(private readonly options: SdkSessionLifecycleOptions) {}

	getActiveSession(): ActiveSession | undefined {
		return this.activeSession
	}

	/** True while the running turn answers an off-the-record side question. */
	isOffTheRecordTurn(): boolean {
		return this.offTheRecordTurn !== undefined
	}

	setRunning(isRunning: boolean): void {
		const activeSession = this.activeSession
		if (!activeSession || activeSession.isRunning === isRunning) {
			return
		}
		activeSession.isRunning = isRunning
		if (isRunning) {
			activeSession.runningSince = Date.now()
			return
		}
		this.flushRunTime(activeSession)
		this.options.onDidBecomeIdle?.()
	}

	/** Reports the run in progress, if any, as elapsed time. */
	private flushRunTime(session: ActiveSession): void {
		const runningSince = session.runningSince
		session.runningSince = undefined
		if (runningSince !== undefined) {
			this.options.onRunElapsed?.(session.sessionId, Date.now() - runningSince)
		}
	}

	private clearActiveSessionReference(): ActiveSession | undefined {
		const activeSession = this.activeSession
		this.activeSession = undefined
		return activeSession
	}

	/**
	 * Take the active session out of the foreground WITHOUT stopping it, so it
	 * can keep running in the background. Its events keep flowing through the
	 * shared host subscription; the caller routes them.
	 */
	detachActiveSession(): ActiveSession | undefined {
		return this.clearActiveSessionReference()
	}

	/** Make a detached (background) session the active one again. */
	adoptSession(session: ActiveSession): void {
		if (this.activeSession && this.activeSession !== session) {
			throw new Error("Cannot adopt a session while another one is active")
		}
		this.activeSession = session
	}

	/** Stop a session that is not the active one (a background task). */
	async stopSession(session: ActiveSession, reason: string): Promise<void> {
		if (this.activeSession === session) {
			await this.endActiveSession(reason)
			return
		}
		this.flushRunTime(session)
		forgetSession(session.sessionId)
		await this.trackSessionStop(session.sdkHost, session.sessionId, reason)
	}

	async endActiveSession(
		reason: string,
		options: { awaitStop?: boolean; timeoutMs?: number } = {},
	): Promise<ActiveSession | undefined> {
		const activeSession = this.clearActiveSessionReference()
		if (!activeSession) {
			return undefined
		}

		this.safeUnsubscribe(activeSession, reason)
		this.flushRunTime(activeSession)
		// Drop the router's per-session state (call log, sticky model, failover
		// budget). Model health is process-wide and deliberately survives.
		forgetSession(activeSession.sessionId)
		const stopPromise = this.trackSessionStop(activeSession.sdkHost, activeSession.sessionId, reason)
		if (options.awaitStop) {
			const timeoutMs = options.timeoutMs ?? 3000
			const stopped = await this.waitForStop(stopPromise, timeoutMs)
			if (!stopped) {
				Logger.warn(
					`[SdkController] Timed out stopping SDK session ${activeSession.sessionId} after ${timeoutMs}ms (${reason})`,
				)
			}
		}
		return activeSession
	}

	/**
	 * Resolves once any in-flight stop for `sessionId` has settled. Callers that
	 * start a session outside startNewSession (e.g. on an isolated host) must
	 * wait here first, or the old session's late cleanup tears down the new one.
	 */
	async waitForPendingStop(sessionId: string): Promise<void> {
		const pendingStop = this.pendingStops.get(sessionId)
		if (pendingStop) {
			Logger.log(`[SdkController] Waiting for session ${sessionId} to stop before restarting it`)
			await pendingStop
		}
	}

	async updateActiveSessionModel(modelId: string): Promise<boolean> {
		const activeSession = this.activeSession
		if (!activeSession?.sdkHost.updateSessionModel) {
			return false
		}

		await activeSession.sdkHost.updateSessionModel(activeSession.sessionId, modelId)
		return true
	}

	async startNewSession(
		startInput: Parameters<VscodeSessionHost["start"]>[0],
	): Promise<{ startResult: StartSessionResult; sdkHost: SdkSessionHost }> {
		if (this.activeSession) {
			await this.endActiveSession("startNewSession")
		}

		// Same-id starts must wait for the previous session's stop to finish;
		// see pendingStops. A fresh id cannot conflict, so it never waits.
		const requestedSessionId = startInput.config?.sessionId?.trim()
		if (requestedSessionId) {
			await this.waitForPendingStop(requestedSessionId)
		}

		const autoApprovalSettings = StateManager.get().getGlobalSettingsKey("autoApprovalSettings")
		const toolPolicies = autoApprovalSettings ? buildToolPolicies(autoApprovalSettings, this.options.mcpHub) : undefined

		const sdkHost = await this.getOrCreateSharedHost()

		const startResult = await sdkHost.start({
			...this.withSessionStartMetadata(startInput),
			...(toolPolicies ? { toolPolicies } : {}),
		})
		this.options.editorState?.syncWithTranscript(startResult.sessionId, startInput.initialMessages)
		this.activeSession = {
			sessionId: startResult.sessionId,
			startConfig: startInput.config
				? {
						providerId: startInput.config.providerId,
						modelId: startInput.config.modelId,
					}
				: undefined,
			sdkHost,
			unsubscribe: () => {},
			startResult,
			isRunning: true,
			runningSince: Date.now(),
		}

		return { startResult, sdkHost }
	}

	async replaceActiveSession(options: {
		expectedSession: ActiveSession
		startInput: Parameters<VscodeSessionHost["start"]>[0]
		initialMessages?: Parameters<VscodeSessionHost["start"]>[0]["initialMessages"]
		disposeReason: string
	}): Promise<
		| {
				oldSessionId: string
				startResult: StartSessionResult
				sdkHost: SdkSessionHost
		  }
		| undefined
	> {
		const oldSession = this.activeSession
		if (!oldSession || oldSession !== options.expectedSession || oldSession.isRunning) {
			return undefined
		}

		const { sessionId: oldSessionId } = oldSession

		// No need to await the stop here: callers reuse oldSessionId in the
		// startInput, and startNewSession waits on the pending stop for it.
		await this.endActiveSession(options.disposeReason)

		const { startResult, sdkHost } = await this.startNewSession({
			...options.startInput,
			...(options.initialMessages ? { initialMessages: options.initialMessages } : {}),
		})
		this.setRunning(false)

		return { oldSessionId, startResult, sdkHost }
	}

	async restoreActiveSession(input: RestoreInput): Promise<RestoreResult> {
		const activeSession = this.activeSession
		if (!activeSession) {
			throw new Error("No active SDK session to restore")
		}

		const sourceSessionId = activeSession.sessionId
		const restored = await activeSession.sdkHost.restore(
			input.start ? { ...input, start: this.withSessionStartMetadata(input.start) } : input,
		)
		if (!restored.startResult || !restored.sessionId) {
			return restored
		}
		// The restored session's transcript was cut back to the checkpoint, and
		// is not in hand here; the next message states the editor again.
		this.options.editorState?.syncWithTranscript(restored.sessionId, undefined)

		this.activeSession = {
			...activeSession,
			sessionId: restored.sessionId,
			startConfig: input.start?.config
				? {
						providerId: input.start.config.providerId,
						modelId: input.start.config.modelId,
					}
				: activeSession.startConfig,
			startResult: restored.startResult,
			isRunning: false,
			runningSince: undefined,
		}

		if (restored.sessionId !== sourceSessionId) {
			const stopPromise = this.trackSessionStop(activeSession.sdkHost, sourceSessionId, "restoreActiveSession")
			stopPromise.catch((error) => {
				Logger.warn(`[SdkController] Failed to stop source session after checkpoint restore: ${sourceSessionId}`, error)
			})
		}

		return restored
	}

	async dispose(reason = "SdkSessionLifecycle.dispose"): Promise<void> {
		await this.endActiveSession(reason, { awaitStop: true })

		const sharedHost = this.sharedHost ?? (await this.sharedHostPromise?.catch(() => undefined))
		this.sharedHost = undefined
		this.sharedHostPromise = undefined
		this.sharedHostUnsubscribe?.()
		this.sharedHostUnsubscribe = undefined
		await sharedHost?.dispose(reason)
	}

	private createSafeUnsubscribe(unsubscribe: () => void, label: string): () => void {
		let unsubscribed = false
		return () => {
			if (unsubscribed) {
				return
			}
			unsubscribed = true
			try {
				unsubscribe()
			} catch (error) {
				Logger.warn(`[SdkController] Failed to unsubscribe SDK session listener (${label}):`, error)
			}
		}
	}

	private safeUnsubscribe(activeSession: ActiveSession, reason: string): void {
		activeSession.unsubscribe()
		Logger.debug(`[SdkController] Unsubscribed SDK session listener: ${activeSession.sessionId} (${reason})`)
	}

	private ensureSharedHostSubscription(sdkHost: SdkSessionHost): void {
		if (this.sharedHostUnsubscribe) {
			return
		}
		this.sharedHostUnsubscribe = this.createSafeUnsubscribe(sdkHost.subscribe(this.options.onSessionEvent), "shared-host")
	}

	/**
	 * Starts the session's stop and records it in pendingStops until it
	 * settles. The returned promise never rejects.
	 */
	private trackSessionStop(sdkHost: SdkSessionHost, sessionId: string, reason: string): Promise<void> {
		const startedAt = Date.now()
		const stopPromise = sdkHost
			.stop(sessionId)
			.then(() => {
				const elapsed = Date.now() - startedAt
				if (elapsed > 250) {
					Logger.log(`[SdkController] SDK session ${sessionId} stopped in ${elapsed}ms (${reason})`)
				}
			})
			.catch((error: unknown) => {
				Logger.warn(`[SdkController] Failed to stop SDK session ${sessionId} (${reason}):`, error)
			})
			.finally(() => {
				if (this.pendingStops.get(sessionId) === stopPromise) {
					this.pendingStops.delete(sessionId)
				}
			})
		this.pendingStops.set(sessionId, stopPromise)
		return stopPromise
	}

	private async waitForStop(stopPromise: Promise<void>, timeoutMs: number): Promise<boolean> {
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined
		try {
			const timeout = new Promise<"timeout">((resolve) => {
				timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs)
			})
			const result = await Promise.race([stopPromise.then(() => "stopped" as const), timeout])
			return result === "stopped"
		} finally {
			clearTimeout(timeoutHandle)
		}
	}

	private async getOrCreateSharedHost(): Promise<SdkSessionHost> {
		if (this.sharedHost) {
			this.ensureSharedHostSubscription(this.sharedHost)
			return this.sharedHost
		}
		if (!this.sharedHostPromise) {
			// Host-lifetime dependencies only. Anything task/session-specific must be
			// supplied to sdkHost.start(...), otherwise it can leak across reused sessions.
			this.sharedHostPromise = VscodeSessionHost.create({
				mcpHub: this.options.mcpHub,
				requestToolApproval: this.options.requestToolApproval,
				askQuestion: this.options.askQuestion,
				editorExecutor: this.options.editorExecutor,
				applyPatchExecutor: this.options.applyPatchExecutor,
				readFileExecutor: this.options.readFileExecutor,
				getTerminalManager: this.options.getTerminalManager,
				foregroundCommands: this.options.foregroundCommands,
			})
				.then((sdkHost) => {
					this.ensureSharedHostSubscription(sdkHost)
					this.sharedHost = sdkHost
					return sdkHost
				})
				.finally(() => {
					this.sharedHostPromise = undefined
				})
		}
		return this.sharedHostPromise
	}

	fireAndForgetSend(
		sdkHost: SdkSessionHost,
		sessionId: string,
		prompt: string,
		images?: string[],
		files?: string[],
		delivery?: "queue" | "steer",
		options: { offTheRecord?: boolean } = {},
	): void {
		// A side question starts a turn of its own; a queued or steering message
		// joins someone else's turn, so the flag does not apply to it.
		const offTheRecord = options.offTheRecord === true && delivery === undefined
		// Captured by object identity, not sessionId: rebuilds (mode change) reuse
		// the same sessionId for the replacement session, so only reference
		// equality can tell this send's session apart from a successor. If the
		// session was replaced by the time the send settles, the settle callbacks
		// must not run bookkeeping against the successor (e.g. flipping a live
		// auto-continued run to isRunning=false, which makes the event coordinator
		// treat the new turn's completion as a cancelled-turn straggler).
		const sessionAtSend = this.activeSession
		const isSuperseded = (label: string, error?: unknown): boolean => {
			if (this.activeSession === sessionAtSend) {
				return false
			}
			Logger.debug(`[SdkController] Ignoring ${label} of superseded send for session: ${sessionId}`)
			this.options.onDetachedSendSettled?.(sessionId, error)
			return true
		}
		// Mark a preceding user-initiated mode switch on this message so the model
		// sees exactly when the rules changed, instead of only inferring it from
		// the user_input mode attribute flipping (mirrors the CLI's
		// run-interactive stamping). The notice survives prepareTurnInput's
		// normalizeUserInput sanitize and is hidden from display surfaces by
		// stripModeNotices.
		// An off-the-record turn is left out of later requests, so it must not use
		// up the notice: the next message on the record carries it instead.
		const notice = offTheRecord ? undefined : this.options.consumeModeSwitchNotice?.(sessionId)
		const noticedPrompt = notice ? `${formatModeSwitchNotice(notice.from, notice.to)}\n${prompt}` : prompt
		this.options.onSendStart?.(sessionId)
		const offTheRecordTurn = offTheRecord ? {} : undefined
		if (delivery === undefined) {
			this.offTheRecordTurn = offTheRecordTurn
		}
		const send = (outboundPrompt: string): void => {
			sdkHost
				.send({
					sessionId,
					prompt: outboundPrompt,
					userImages: images,
					userFiles: files,
					delivery,
					...(offTheRecord ? { offTheRecord: true } : {}),
				})
				.finally(() => {
					if (offTheRecordTurn && this.offTheRecordTurn === offTheRecordTurn) {
						this.offTheRecordTurn = undefined
					}
				})
				.then(async () => {
					if (delivery === "queue" || delivery === "steer") {
						Logger.log(`[SdkController] Message queued for session: ${sessionId}`)
						return
					}
					if (isSuperseded("completion")) {
						return
					}
					Logger.log(`[SdkController] Agent turn completed for session: ${sessionId}`)
					this.setRunning(false)
					await this.options.onSendComplete(sessionId)
				})
				.catch(async (error: unknown) => {
					if (isAbortError(error)) {
						Logger.debug(`[SdkController] Agent turn aborted (expected): ${sessionId}`)
						return
					}
					if (isSuperseded("failure", error)) {
						return
					}
					Logger.error("[SdkController] Agent turn failed:", error)
					this.setRunning(false)
					await this.options.onSendError(error, sessionId)
				})
		}

		const editorState = this.options.editorState
		if (!editorState) {
			send(noticedPrompt)
			return
		}
		// Reading the editor is asynchronous, so sends go through one chain and
		// leave in the order they were made. The block goes after the user's
		// text, like a mode notice goes before it: both reach the model and
		// stripModeNotices keeps both out of every display surface.
		const userTyped = prompt.trim().length > 0 && !isSyntheticUserPrompt(prompt)
		this.outboundSends = this.outboundSends
			.then(async () => {
				// A side question sees the editor too, but is not remembered as having been
				// told: the next message on the record still gets any change.
				const read = () =>
					offTheRecord ? editorState.nextBlock(sessionId, { remember: false }) : editorState.nextBlock(sessionId)
				const block = userTyped ? await read().catch(() => undefined) : undefined
				send(block ? `${noticedPrompt}\n\n${block}` : noticedPrompt)
			})
			.catch(async (error: unknown) => {
				Logger.error(`[SdkController] Failed to hand a message to session ${sessionId}:`, error)
				if (isSuperseded("failure", error)) {
					return
				}
				this.setRunning(false)
				await this.options.onSendError(error, sessionId)
			})
	}

	/** Adds getSessionStartMetadata's entries to a start input's session metadata. */
	private withSessionStartMetadata<T extends { config?: { sessionId?: string }; sessionMetadata?: Record<string, unknown> }>(
		startInput: T,
	): T {
		const metadata = this.options.getSessionStartMetadata?.(startInput.config?.sessionId?.trim() || undefined)
		return metadata ? { ...startInput, sessionMetadata: { ...(startInput.sessionMetadata ?? {}), ...metadata } } : startInput
	}
}

export function isAbortError(error: unknown): boolean {
	if (error instanceof Error) {
		return error.name === "AbortError" || error.message.toLowerCase().includes("aborted")
	}
	return false
}
