import { createSessionId } from "@plinycode/shared"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import type { Settings } from "@shared/storage/state-keys"
import type { Mode } from "@shared/storage/types"
import type { WorkspaceRef } from "@shared/workspaceRef"
import type { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"
import { isDirectory } from "@/utils/fs"
import type { SdkMessageCoordinator } from "./sdk-message-coordinator"
import type { SdkSessionConfigBuilder } from "./sdk-session-config-builder"
import type { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import { historyItemToSessionMetadata, type SdkTaskHistory } from "./sdk-task-history"
import type { SdkSessionHost } from "./session-host"
import { createTaskProxy, type TaskProxy } from "./task-proxy"
import type { VscodeSessionHost } from "./vscode-session-host"

type StartInput = Parameters<VscodeSessionHost["start"]>[0]
type InitialMessages = StartInput["initialMessages"]
type SessionConfig = Awaited<ReturnType<SdkSessionConfigBuilder["build"]>>

export interface SdkTaskStartCoordinatorOptions {
	stateManager: StateManager
	sessions: SdkSessionLifecycle
	messages: SdkMessageCoordinator
	taskHistory: SdkTaskHistory
	sessionConfigBuilder: SdkSessionConfigBuilder
	buildStartSessionInput: (
		config: SessionConfig,
		input: {
			prompt?: string
			images?: string[]
			files?: string[]
			historyItem?: HistoryItem
			taskSettings?: Partial<Settings>
			cwd: string
			mode: Mode
		},
	) => StartInput
	createHistoryItemFromSession: (
		sessionId: string,
		prompt: string,
		modelId?: string,
		cwd?: string,
		workspaceRoot?: string,
		workspace?: WorkspaceRef,
	) => HistoryItem
	/** detachRunning keeps a running task going in the background. */
	clearTask: (options?: { detachRunning?: boolean }) => Promise<void>
	setTask: (task: TaskProxy | undefined) => void
	onAskResponse: (text?: string, images?: string[], files?: string[], delivery?: string) => Promise<void>
	onCancelTask: () => Promise<void>
	getWorkspaceRoot: () => Promise<string>
	/**
	 * The workspace the window is open on, which new tasks bind to unless the
	 * caller passes another one. Undefined in an empty window.
	 */
	getWindowWorkspace?: () => Promise<WorkspaceRef | undefined>
	/**
	 * Tells the controller which workspace the task it is about to run lives in,
	 * so workspace-root lookups made on the task's behalf (mentions, edits,
	 * mode rebuilds) resolve there rather than in the window's folder. Called
	 * after clearTask, with undefined folders when the task runs in the window.
	 */
	setActiveTaskWorkspace?: (workspace: WorkspaceRef | undefined, cwd: string) => void
	/** A task is starting in this workspace; the controller records it as recently used. */
	onWorkspaceUsed?: (workspace: WorkspaceRef | undefined) => void
	createTempSessionHost: () => Promise<SdkSessionHost>
	loadInitialMessages: (reader: SdkSessionHost, taskId: string) => Promise<unknown[] | undefined>
	resolveContextMentions: (text: string) => Promise<string>
	postStateToWebview: () => Promise<void>
}

export class SdkTaskStartCoordinator {
	constructor(private readonly options: SdkTaskStartCoordinatorOptions) {}

	async initTask(
		prompt?: string,
		images?: string[],
		files?: string[],
		historyItem?: HistoryItem,
		taskSettings?: Partial<Settings>,
		workspace?: WorkspaceRef,
	): Promise<string | undefined> {
		Logger.log(`[SdkController] initTask called: "${prompt?.substring(0, 50)}"`)
		let taskSessionId: string | undefined
		try {
			await this.options.clearTask({ detachRunning: true })

			const { cwd, workspace: boundWorkspace } = await this.resolveTaskWorkspace(workspace)
			this.options.setActiveTaskWorkspace?.(boundWorkspace, cwd)
			this.options.onWorkspaceUsed?.(boundWorkspace)
			const mode = this.getCurrentMode()
			Logger.log(`[SdkController] Building session config: mode=${mode}, cwd=${cwd}`)
			const config = await this.options.sessionConfigBuilder.build({
				prompt,
				images,
				files,
				historyItem,
				taskSettings,
				cwd,
				mode,
			})

			Logger.log(
				`[SdkController] Session config: provider=${config.providerId}, model=${config.modelId}, hasApiKey=${!!config.apiKey}`,
			)

			taskSessionId = config.sessionId?.trim() || createSessionId()
			const configWithSessionId = {
				...config,
				sessionId: taskSessionId,
			}

			const startInput = {
				...this.options.buildStartSessionInput(configWithSessionId, {
					prompt: prompt,
					images,
					files,
					historyItem,
					taskSettings,
					cwd,
					mode,
				}),
				// Bind the session record to its workspace from the first write, so
				// another window listing history sees the binding before the first
				// history update lands.
				...(boundWorkspace
					? { sessionMetadata: { workspacePath: boundWorkspace.path, workspaceKind: boundWorkspace.kind } }
					: {}),
			}

			const task = this.createAndSetTask(taskSessionId)
			this.emitInitialTaskMessage(taskSessionId, prompt ?? "", images, files)

			// The turn phase was already set to "streaming" (in SdkController.initTask), but the
			// webview only learns the phase through a full state post. Ship one now, in parallel
			// with the potentially slow session startup below, so the chat shows the thinking
			// indicator as soon as the task message lands instead of after startNewSession settles.
			this.options.postStateToWebview().catch((error) => {
				Logger.error("[SdkController] Failed to post state after emitting initial task message:", error)
			})

			const { startResult, sdkHost } = await this.options.sessions.startNewSession(startInput)
			if (startResult.sessionId !== taskSessionId) {
				Logger.warn(
					`[SdkController] SDK returned session id ${startResult.sessionId} after requested id ${taskSessionId}`,
				)
				task.taskId = startResult.sessionId
				taskSessionId = startResult.sessionId
			}

			const newHistoryItem = this.options.createHistoryItemFromSession(
				taskSessionId,
				prompt ?? "",
				configWithSessionId.modelId,
				cwd,
				configWithSessionId.workspaceRoot ?? cwd,
				boundWorkspace,
			)
			await this.options.taskHistory.updateTaskHistoryItem(newHistoryItem)
			await this.options.postStateToWebview()

			if (prompt?.trim() || images?.length || files?.length) {
				Logger.log(`[SdkController] Sending prompt to session: ${taskSessionId}`)
				const resolvedTask = await this.options.resolveContextMentions(prompt || "")
				this.options.sessions.fireAndForgetSend(sdkHost, taskSessionId, resolvedTask, images, files)
			}

			Logger.log(`[SdkController] Task initialized: ${taskSessionId}`)
			return taskSessionId
		} catch (error) {
			this.handleInitError(error, taskSessionId)
			await this.options.postStateToWebview().catch((postError) => {
				Logger.error("[SdkController] Failed to post state after init error:", postError)
			})
			return undefined
		}
	}

	async reinitExistingTaskFromId(taskId: string): Promise<void> {
		try {
			await this.options.clearTask()

			const historyItem = await this.options.taskHistory.findHistoryItem(taskId)
			if (!historyItem) {
				Logger.error(`[SdkController] Task not found in history: ${taskId}`)
				return
			}

			// A task's stored cwd may have been deleted/moved since the task ran
			// (or migrated from another machine) — feeding a stale path into the
			// session bootstrap makes workspace init fail. Fall back to the live
			// workspace root instead.
			const storedCwd = historyItem.cwdOnTaskInitialization
			const cwd = storedCwd && (await isDirectory(storedCwd)) ? storedCwd : await this.options.getWorkspaceRoot()
			this.options.setActiveTaskWorkspace?.(
				historyItem.workspacePath
					? { path: historyItem.workspacePath, kind: historyItem.workspaceKind ?? "folder", folders: [cwd] }
					: undefined,
				cwd,
			)
			const config = await this.options.sessionConfigBuilder.build({
				cwd,
				mode: "act",
			})

			const tempManager = await this.options.createTempSessionHost()
			const initialMessages = await this.options.loadInitialMessages(tempManager, taskId)
			await tempManager.dispose("readMessages")

			const { startResult } = await this.options.sessions.startNewSession({
				config,
				interactive: true,
				...(initialMessages ? { initialMessages: initialMessages as InitialMessages } : {}),
				sessionMetadata: historyItemToSessionMetadata(historyItem, config.modelId),
			})

			this.createAndSetTask(startResult.sessionId)
			await this.options.postStateToWebview()

			Logger.log(`[SdkController] Task resumed: ${taskId} → ${startResult.sessionId}`)
		} catch (error) {
			this.handleReinitError(taskId, error)
		}
	}

	/**
	 * Where a new task runs and which workspace it is bound to. An explicitly
	 * chosen workspace runs in its first folder, which must exist; otherwise the
	 * task runs in the window's workspace root and binds to the window's
	 * workspace (when the window has one).
	 */
	private async resolveTaskWorkspace(
		requested: WorkspaceRef | undefined,
	): Promise<{ cwd: string; workspace: WorkspaceRef | undefined }> {
		if (requested) {
			const folder = requested.folders.find((entry) => entry.trim().length > 0)
			if (!folder || !(await isDirectory(folder))) {
				throw new Error(
					`The workspace folder ${folder ?? requested.path} does not exist. Pick another workspace to start the conversation in.`,
				)
			}
			return { cwd: folder, workspace: requested }
		}
		const cwd = await this.options.getWorkspaceRoot()
		return { cwd, workspace: await this.options.getWindowWorkspace?.() }
	}

	private getCurrentMode(): Mode {
		const m = this.options.stateManager.getGlobalSettingsKey("mode")
		return m === "plan" ? m : "act"
	}

	private createAndSetTask(sessionId: string): TaskProxy {
		const task = createTaskProxy(
			sessionId,
			(text?: string, images?: string[], files?: string[], delivery?: string) =>
				this.options.onAskResponse(text, images, files, delivery),
			() => this.options.onCancelTask(),
		)
		this.options.setTask(task)
		return task
	}

	private emitInitialTaskMessage(sessionId: string, task: string, images?: string[], files?: string[]): void {
		// Attachments must ride on the authoritative task message: the webview's
		// optimistic pending copy is only cleared once an identical message (text
		// AND images/files) arrives from the extension. Omitting them left the
		// optimistic message unconfirmed forever, so it was re-injected into the
		// transcript even after "New Task" cleared it (#12924).
		const taskMessage: ClineMessage = {
			ts: Date.now(),
			type: "say",
			say: "task",
			text: task,
			...(images?.length ? { images } : {}),
			...(files?.length ? { files } : {}),
			partial: false,
		}
		this.options.messages.appendAndEmit([taskMessage], {
			type: "status",
			payload: { sessionId, status: "running" },
		})
	}

	private handleInitError(error: unknown, sessionId?: string): void {
		const errorDetails =
			error instanceof Error ? `${error.name}: ${error.message}\n${error.stack?.substring(0, 500)}` : String(error)
		Logger.error(`[SdkController] Failed to init task: ${errorDetails}`)
		;(globalThis as Record<string, unknown>).__cline_last_init_error = errorDetails
		;(globalThis as Record<string, unknown>).__cline_last_init_error_raw = error
		this.options.messages.appendAndEmit(
			[
				{
					ts: Date.now(),
					type: "say",
					say: "error",
					text: `Failed to start task: ${error instanceof Error ? error.message : String(error)}`,
					partial: false,
				},
			],
			{ type: "status", payload: { sessionId: sessionId ?? "", status: "error" } },
		)
	}

	private handleReinitError(taskId: string, error: unknown): void {
		Logger.error("[SdkController] Failed to reinit task:", error)

		const reinitErrorMsg = error instanceof Error ? error.message : String(error)

		this.options.messages.emitSessionEvents(
			[
				{
					ts: Date.now(),
					type: "say",
					say: "error",
					text: `Failed to resume task: ${reinitErrorMsg}`,
					partial: false,
				},
			],
			{ type: "status", payload: { sessionId: taskId, status: "error" } },
		)
	}
}
