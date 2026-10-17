import path from "node:path"
import { createSessionId } from "@plinycode/shared"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem, TaskWorktree } from "@shared/HistoryItem"
import type { Settings } from "@shared/storage/state-keys"
import { type Mode, toMode } from "@shared/storage/types"
import type { WorkspaceRef } from "@shared/workspaceRef"
import type { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"
import { isDirectory } from "@/utils/fs"
import type { SdkBackgroundSessions } from "./sdk-background-sessions"
import type { SdkMessageCoordinator } from "./sdk-message-coordinator"
import type { SdkSessionConfigBuilder } from "./sdk-session-config-builder"
import type { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import { historyItemToSessionMetadata, type SdkTaskHistory } from "./sdk-task-history"
import type { SdkSessionHost } from "./session-host"
import { type AskResponseCallback, createTaskProxy, type TaskProxy } from "./task-proxy"
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
	onAskResponse: AskResponseCallback
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
	/** Where tasks started straight into the background live. */
	background?: Pick<SdkBackgroundSessions, "isFull" | "add" | "handleSendSettled">
	/** How many background tasks run in `cwd`; a new task there is warned that they share the working tree. */
	backgroundSessionsInFolder?: (cwd: string) => number
	/**
	 * Creates a git worktree for a conversation started with "Run in worktree":
	 * a new branch named after `title`, from the current commit of the repository
	 * that holds `folder` (see `ensureTaskWorktree`). Throws with a message for the user.
	 */
	createTaskWorktree?: (input: { folder: string; title: string }) => Promise<TaskWorktree & { notes: string[] }>
}

export interface TaskStartOptions {
	/**
	 * False keeps the task's workspace out of the recently used list, e.g. for
	 * a CI board run in a throwaway git worktree. Default true.
	 */
	recordRecentWorkspace?: boolean
	/** Runs the conversation on this model through every rebuild and resume, e.g. a CI board run on FreeAuto. */
	modelId?: string
	/**
	 * The mode the task's session is built in. Default: the mode switch's current position. A CI
	 * Board action passes its own (Agent, or Ask for Investigate) without moving the switch for the
	 * task that is displayed; a background start keeps the mode it was started in.
	 */
	mode?: Mode
	/** A title for the conversation's history entry, when the prompt makes a poor one. */
	title?: string
	/**
	 * Runs the conversation in a new git worktree of the workspace's repository
	 * ("Run in worktree", docs/task-worktrees.md): the worktree becomes its cwd
	 * and the workspace it is bound to. When the worktree cannot be created, the
	 * start fails with an error row and nothing runs.
	 */
	worktree?: boolean
}

export type BackgroundStartResult =
	| { status: "started"; conversationId: string }
	| { status: "full" }
	| { status: "error"; message: string }

export class SdkTaskStartCoordinator {
	constructor(private readonly options: SdkTaskStartCoordinatorOptions) {}

	async initTask(
		prompt?: string,
		images?: string[],
		files?: string[],
		historyItem?: HistoryItem,
		taskSettings?: Partial<Settings>,
		workspace?: WorkspaceRef,
		startOptions?: TaskStartOptions,
	): Promise<string | undefined> {
		Logger.log(`[SdkController] initTask called: "${prompt?.substring(0, 50)}"`)
		let taskSessionId: string | undefined
		try {
			await this.options.clearTask({ detachRunning: true })

			const source = await this.resolveTaskWorkspace(workspace)
			const {
				cwd,
				workspace: boundWorkspace,
				worktree,
				worktreeNotes,
			} = startOptions?.worktree
				? await this.moveIntoWorktree(source, startOptions.title ?? prompt ?? "")
				: { ...source, worktree: undefined, worktreeNotes: [] }
			this.options.setActiveTaskWorkspace?.(boundWorkspace, cwd)
			if (startOptions?.recordRecentWorkspace !== false) {
				// The workspace the user picked, not a worktree made for one conversation.
				this.options.onWorkspaceUsed?.(source.workspace)
			}
			const mode = startOptions?.mode ?? this.getCurrentMode()
			Logger.log(`[SdkController] Building session config: mode=${mode}, cwd=${cwd}`)
			const config = await this.options.sessionConfigBuilder.build({
				prompt,
				images,
				files,
				historyItem,
				taskSettings,
				cwd,
				mode,
				modelId: startOptions?.modelId,
			})

			Logger.log(
				`[SdkController] Session config: provider=${config.providerId}, model=${config.modelId}, hasApiKey=${!!config.apiKey}`,
			)

			taskSessionId = config.sessionId?.trim() || createSessionId()
			if (startOptions?.modelId) {
				this.options.sessionConfigBuilder.pinModel(taskSessionId, startOptions.modelId)
			}
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
					? {
							sessionMetadata: {
								workspacePath: boundWorkspace.path,
								workspaceKind: boundWorkspace.kind,
								...(worktree ? { worktree } : {}),
							},
						}
					: {}),
			}

			const task = this.createAndSetTask(taskSessionId)
			this.emitInitialTaskMessage(taskSessionId, prompt ?? "", images, files)
			if (worktree) {
				this.announceWorktree(worktree, worktreeNotes)
			}
			this.warnIfFolderShared(cwd)

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
			if (startOptions?.modelId) {
				this.options.sessionConfigBuilder.pinModel(taskSessionId, startOptions.modelId)
				newHistoryItem.pinnedModelId = startOptions.modelId
			}
			if (startOptions?.title) newHistoryItem.task = startOptions.title
			if (worktree) newHistoryItem.worktree = worktree
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

	/**
	 * Starts a conversation that runs in the background from its first turn,
	 * leaving the displayed task, its session and the mode switch alone. Like
	 * any background task, it is stopped and the user notified when its turn
	 * ends. The prompt is sent as is: no mention or slash-command expansion.
	 */
	async startBackgroundTask(
		prompt: string,
		workspace: WorkspaceRef | undefined,
		startOptions: TaskStartOptions = {},
	): Promise<BackgroundStartResult> {
		const background = this.options.background
		if (!background) {
			return { status: "error", message: "Background tasks are not available." }
		}
		if (background.isFull) {
			return { status: "full" }
		}
		let session: Awaited<ReturnType<SdkSessionLifecycle["startDetachedSession"]>>["session"] | undefined
		try {
			const { cwd, workspace: boundWorkspace } = await this.resolveTaskWorkspace(workspace)
			const mode = startOptions.mode ?? "act"
			const config = await this.options.sessionConfigBuilder.build({
				prompt,
				cwd,
				mode,
				modelId: startOptions.modelId,
				newConversation: true,
			})
			const sessionId = config.sessionId?.trim() || createSessionId()
			if (startOptions.modelId) {
				this.options.sessionConfigBuilder.pinModel(sessionId, startOptions.modelId)
			}
			const configWithSessionId = { ...config, sessionId }
			const startInput = {
				...this.options.buildStartSessionInput(configWithSessionId, { prompt, cwd, mode }),
				...(boundWorkspace
					? { sessionMetadata: { workspacePath: boundWorkspace.path, workspaceKind: boundWorkspace.kind } }
					: {}),
			}
			const started = await this.options.sessions.startDetachedSession(startInput)
			session = started.session
			const conversationId = started.startResult.sessionId
			if (conversationId !== sessionId && startOptions.modelId) {
				this.options.sessionConfigBuilder.pinModel(conversationId, startOptions.modelId)
			}
			const title = startOptions.title ?? prompt
			if (!background.add(session, title)) {
				await this.options.sessions.stopSession(session, "backgroundFull")
				return { status: "full" }
			}
			const historyItem = this.options.createHistoryItemFromSession(
				conversationId,
				prompt,
				configWithSessionId.modelId,
				cwd,
				configWithSessionId.workspaceRoot ?? cwd,
				boundWorkspace,
			)
			if (startOptions.modelId) historyItem.pinnedModelId = startOptions.modelId
			if (startOptions.title) historyItem.task = startOptions.title
			await this.options.taskHistory.updateTaskHistoryItem(historyItem)
			session.sdkHost.send({ sessionId: conversationId, prompt }).then(
				() => background.handleSendSettled(conversationId),
				(error) => background.handleSendSettled(conversationId, error ?? new Error("send failed")),
			)
			await this.options.postStateToWebview()
			Logger.log(`[SdkController] Background task started: ${conversationId}`)
			return { status: "started", conversationId }
		} catch (error) {
			Logger.error("[SdkController] Failed to start a background task:", error)
			if (session) {
				await this.options.sessions.stopSession(session, "backgroundStartFailed").catch(() => undefined)
			}
			return { status: "error", message: error instanceof Error ? error.message : String(error) }
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
			if (historyItem.pinnedModelId) {
				this.options.sessionConfigBuilder.pinModel(taskId, historyItem.pinnedModelId)
			}
			const config = await this.options.sessionConfigBuilder.build({
				cwd,
				mode: this.getCurrentMode(),
				modelId: historyItem.pinnedModelId,
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
			if (historyItem.worktree && cwd !== storedCwd) {
				this.options.messages.emitHookMessage({
					ts: Date.now(),
					type: "say",
					say: "info",
					partial: false,
					text: `The worktree ${historyItem.worktree.path} no longer exists, so this conversation now works in ${cwd}.`,
				})
			}
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

	/**
	 * "Run in worktree": creates a worktree of the repository that holds the
	 * task's folder and moves the task into it. The task runs in the same
	 * subfolder of the worktree when that exists (the window may be open on a
	 * folder below the repository's top level), and is bound to it as a folder
	 * workspace; `sourceWorkspacePath` keeps it in the source workspace's history.
	 */
	private async moveIntoWorktree(
		source: { cwd: string; workspace: WorkspaceRef | undefined },
		title: string,
	): Promise<{ cwd: string; workspace: WorkspaceRef; worktree: TaskWorktree; worktreeNotes: string[] }> {
		const create = this.options.createTaskWorktree
		if (!create) {
			throw new Error("Running a conversation in a worktree is not available here.")
		}
		let created: Awaited<ReturnType<typeof create>>
		try {
			created = await create({ folder: source.cwd, title })
		} catch (error) {
			throw new Error(
				`Could not create a git worktree for this conversation: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		const { notes, ...location } = created
		const relative = path.relative(location.repoRoot, source.cwd)
		const subfolder =
			relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? path.join(location.path, relative) : undefined
		const cwd = subfolder && (await isDirectory(subfolder)) ? subfolder : location.path
		const worktree: TaskWorktree = {
			...location,
			...(source.workspace ? { sourceWorkspacePath: source.workspace.path } : {}),
		}
		return { cwd, workspace: { path: cwd, kind: "folder", folders: [cwd] }, worktree, worktreeNotes: notes }
	}

	/** Tells the user where a worktree conversation works, once, as an info row. */
	private announceWorktree(worktree: TaskWorktree, notes: string[]): void {
		this.options.messages.emitHookMessage({
			ts: Date.now(),
			type: "say",
			say: "info",
			partial: false,
			text: [
				`This conversation works in a git worktree on the new branch ${worktree.branch}: ${worktree.path}. It starts from the current commit of ${worktree.repoRoot}, and your checkout there is not touched.`,
				...notes,
			].join("\n\n"),
		})
	}

	private getCurrentMode(): Mode {
		return toMode(this.options.stateManager.getGlobalSettingsKey("mode"))
	}

	/**
	 * Checkpoints snapshot the whole working tree of a folder, and the reviewer
	 * reads the run's changes from them, so two tasks in one folder see each
	 * other's edits. The CI Board runs in worktrees for this reason; a task the
	 * user starts next to a background one is told once.
	 */
	private warnIfFolderShared(cwd: string): void {
		const others = this.options.backgroundSessionsInFolder?.(cwd) ?? 0
		if (others <= 0) {
			return
		}
		this.options.messages.emitHookMessage({
			ts: Date.now(),
			type: "say",
			say: "info",
			partial: false,
			text:
				others === 1
					? 'Another task is still running in this folder. Checkpoints, "View changes" and the reviewer\'s diff include its edits too.'
					: `${others} other tasks are still running in this folder. Checkpoints, "View changes" and the reviewer's diff include their edits too.`,
		})
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
