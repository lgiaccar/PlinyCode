import * as path from "node:path"
import { type CompareCheckpointResult, readSessionCheckpointHistory } from "@plinycode/core"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { ChangedFileSummary, LatestChangesSummary } from "@shared/proto/cline/checkpoints"
import type { Mode } from "@shared/storage/types"
import type { ClineCheckpointRestore } from "@shared/WebviewMessage"
import { HostProvider } from "@/hosts/host-provider"
import { buildChangedFileSummaries } from "@/shared/checkpoint-changes-summary"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { buildStartSessionInput } from "./cline-session-factory"
import {
	findVisibleCheckpointUserMessageByRun,
	getCheckpointRunCountForMessage,
	isVisibleCheckpointUserMessage,
} from "./sdk-checkpoints"
import type { SdkMessageCoordinator } from "./sdk-message-coordinator"
import type { SdkSessionConfigBuilder } from "./sdk-session-config-builder"
import type { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import { createHistoryItemFromSession, type SdkTaskHistory } from "./sdk-task-history"
import type { TaskProxy } from "./task-proxy"
import { createTaskProxy } from "./task-proxy"
import type { TurnStateTracker } from "./turn-state-tracker"
import type { VscodeSessionHost } from "./vscode-session-host"

type CheckpointComparison = {
	sessionId: string
	checkpointRunCount: number
	cwd: string
	diffs: CompareCheckpointResult["diffs"]
}

export interface SdkCheckpointCoordinatorOptions {
	sessions: SdkSessionLifecycle
	messages: SdkMessageCoordinator
	taskHistory: SdkTaskHistory
	sessionConfigBuilder: SdkSessionConfigBuilder
	turnStateTracker: TurnStateTracker
	getTask: () => TaskProxy | undefined
	setTask: (task: TaskProxy | undefined) => void
	getWorkspaceRoot: () => Promise<string>
	getMode: () => Mode
	createTempSessionHost: () => Promise<VscodeSessionHost>
	askResponse: (text?: string, images?: string[], files?: string[]) => Promise<void>
	cancelTask: () => Promise<void>
	resetMessageTranslatorAndFence: () => void
	clearTurnOutcome: () => void
	replaceMessages: (messages: ClineMessage[]) => void
	postStateToWebview: () => Promise<void>
	onCheckpointRestoreInput: (input: { text: string; images: string[]; files: string[]; sessionId: string }) => void
}

/**
 * Checkpoint restore and "view changes" flows: restoring a task/workspace to
 * an earlier checkpoint, and comparing the latest checkpoint against the
 * current working tree for the completion row's "View Changes" and the
 * per-file diff viewer. Extracted from SdkController, which still owns the
 * per-controller comparison cache and forwards these calls to the coordinator.
 */
export class SdkCheckpointCoordinator {
	private latestCheckpointComparisonCache?: CheckpointComparison

	constructor(private readonly options: SdkCheckpointCoordinatorOptions) {}

	async restoreCheckpoint(input: { checkpointRunCount: number; restoreType: ClineCheckpointRestore }): Promise<void> {
		const restoreMessages = input.restoreType === "task" || input.restoreType === "taskAndWorkspace"
		const restoreWorkspace = input.restoreType === "workspace" || input.restoreType === "taskAndWorkspace"
		const checkpointRunCount = Number(input.checkpointRunCount)
		if (!Number.isInteger(checkpointRunCount) || checkpointRunCount < 1) {
			throw new Error("checkpointRunCount must be a positive integer")
		}

		const activeSession = this.options.sessions.getActiveSession()
		const currentTask = this.options.getTask()
		if (!activeSession || !currentTask) {
			throw new Error("No active task to restore")
		}
		if (activeSession.isRunning) {
			await this.options.cancelTask()
		}

		const currentMessages = currentTask.messageStateHandler.getClineMessages()
		const target = restoreMessages ? findVisibleCheckpointUserMessageByRun(currentMessages, checkpointRunCount) : undefined
		if (restoreMessages && !target) {
			throw new Error(`Could not find user message for checkpoint run ${checkpointRunCount}`)
		}

		const cwd = await this.options.getWorkspaceRoot()
		const mode = this.options.getMode()
		const firstUserMessage = currentMessages.find(isVisibleCheckpointUserMessage)
		const restoredText = target?.message.text ?? ""
		const historyTitle = checkpointRunCount === 1 ? restoredText : firstUserMessage?.text || restoredText
		const config = restoreMessages
			? await this.options.sessionConfigBuilder.build({ cwd, mode, prompt: historyTitle })
			: undefined

		const startInput = config
			? {
					...buildStartSessionInput(config, { prompt: historyTitle, cwd, mode }),
					sessionMetadata: {
						title: historyTitle,
						modelId: config.modelId,
					},
				}
			: undefined

		// The restore starts a new session; its history record keeps the star and the pin.
		const previousHistoryItem = restoreMessages
			? await this.options.taskHistory.findHistoryItem(activeSession.sessionId).catch(() => undefined)
			: undefined

		const restored = await this.options.sessions.restoreActiveSession({
			sessionId: activeSession.sessionId,
			checkpointRunCount,
			cwd,
			restore: {
				messages: restoreMessages,
				workspace: restoreWorkspace,
				omitCheckpointMessageFromSession: true,
			},
			...(startInput ? { start: startInput } : {}),
		})

		if (!restoreMessages) {
			await this.options.postStateToWebview()
			return
		}

		if (!restored.sessionId || !restored.startResult || !target) {
			throw new Error("Checkpoint restore did not return a new session")
		}

		this.options.turnStateTracker.set("idle")
		this.options.clearTurnOutcome()
		this.options.resetMessageTranslatorAndFence()

		const task = createTaskProxy(
			restored.sessionId,
			(text?: string, images?: string[], files?: string[]) => this.options.askResponse(text, images, files),
			() => this.options.cancelTask(),
		)
		this.options.setTask(task)

		const newHistoryItem = {
			...createHistoryItemFromSession(
				restored.sessionId,
				historyTitle,
				config?.modelId ?? "",
				cwd,
				config?.workspaceRoot ?? cwd,
			),
			isFavorited: previousHistoryItem?.isFavorited,
			isPinned: previousHistoryItem?.isPinned,
		}
		await this.options.taskHistory.updateTaskHistoryItem(newHistoryItem)

		const visibleMessages = currentMessages.slice(0, target.index)
		if (visibleMessages.length > 0) {
			this.options.replaceMessages(visibleMessages)
		}

		this.options.onCheckpointRestoreInput({
			text: restoredText,
			images: target.message.images ?? [],
			files: target.message.files ?? [],
			sessionId: restored.sessionId,
		})
		await this.options.postStateToWebview()
	}

	/**
	 * Diffs the latest checkpoint — snapshotted when the user's last message
	 * started a run — against the current working tree. Returns undefined when
	 * no checkpoint exists (e.g. the workspace is not a git repository).
	 * Throws when there is no task at all.
	 */
	private resolveCheckpointRunCountForSummary(input?: { checkpointRunCount?: number; messageTs?: number }): number | undefined {
		if (input?.checkpointRunCount !== undefined && input.checkpointRunCount > 0) {
			return input.checkpointRunCount
		}
		if (input?.messageTs !== undefined && input.messageTs > 0) {
			const clineMessages = this.options.getTask()?.messageStateHandler.getClineMessages() ?? []
			const targetIndex = clineMessages.findIndex((message) => message.ts === input.messageTs)
			if (targetIndex === -1) {
				return undefined
			}
			return getCheckpointRunCountForMessage(clineMessages, targetIndex)
		}
		return undefined
	}

	private async loadCheckpointComparison(checkpointRunCount?: number): Promise<CheckpointComparison | undefined> {
		const activeSession = this.options.sessions.getActiveSession()
		const sessionId = activeSession?.sessionId ?? this.options.getTask()?.taskId
		if (!sessionId) {
			throw new Error("No active task to show changes for")
		}

		// After a window reload the latest task is shown from history without a
		// live session, so fall back to a temporary host for the comparison.
		let tempHost: VscodeSessionHost | undefined
		const sessionHost = activeSession?.sdkHost ?? (tempHost = await this.options.createTempSessionHost())
		try {
			if (!sessionHost.compareCheckpoint) {
				throw new Error("This session host does not support checkpoint comparison")
			}

			const sessionRecord = await sessionHost.get(sessionId)
			let resolvedRunCount = checkpointRunCount
			if (resolvedRunCount === undefined) {
				const latestCheckpoint = readSessionCheckpointHistory(sessionRecord).reduce(
					(latest, entry) => (!latest || entry.runCount > latest.runCount ? entry : latest),
					undefined as ReturnType<typeof readSessionCheckpointHistory>[number] | undefined,
				)
				if (!latestCheckpoint) {
					return undefined
				}
				resolvedRunCount = latestCheckpoint.runCount
			}

			const cached = this.latestCheckpointComparisonCache
			if (cached?.sessionId === sessionId && cached.checkpointRunCount === resolvedRunCount) {
				return cached
			}

			const cwd =
				sessionRecord?.cwd?.trim() || sessionRecord?.workspaceRoot?.trim() || (await this.options.getWorkspaceRoot())
			const { diffs } = await sessionHost.compareCheckpoint({
				sessionId,
				checkpointRunCount: resolvedRunCount,
				cwd,
			})
			const result = {
				sessionId,
				checkpointRunCount: resolvedRunCount,
				cwd,
				diffs,
			}
			this.latestCheckpointComparisonCache = result
			return result
		} finally {
			await tempHost?.dispose("viewLatestCheckpointChanges")
		}
	}

	/**
	 * What a session's current run has changed so far: its latest checkpoint —
	 * snapshotted when the user's last message started the run — against the
	 * working tree as it is now. For the reviewer pass, which reads it before
	 * the run ends, so it is never served from the "View Changes" cache.
	 * Returns undefined when the session has no checkpoint.
	 */
	async getRunChanges(sessionId: string): Promise<Pick<CheckpointComparison, "cwd" | "diffs"> | undefined> {
		const activeSession = this.options.sessions.getActiveSession()
		// A background session is not the active one; its record is read through a temporary host.
		let tempHost: VscodeSessionHost | undefined
		const sessionHost =
			activeSession?.sessionId === sessionId
				? activeSession.sdkHost
				: (tempHost = await this.options.createTempSessionHost())
		try {
			if (!sessionHost.compareCheckpoint) {
				return undefined
			}
			const sessionRecord = await sessionHost.get(sessionId)
			const latestCheckpoint = readSessionCheckpointHistory(sessionRecord).reduce(
				(latest, entry) => (!latest || entry.runCount > latest.runCount ? entry : latest),
				undefined as ReturnType<typeof readSessionCheckpointHistory>[number] | undefined,
			)
			if (!latestCheckpoint) {
				return undefined
			}
			const cwd =
				sessionRecord?.cwd?.trim() || sessionRecord?.workspaceRoot?.trim() || (await this.options.getWorkspaceRoot())
			const { diffs } = await sessionHost.compareCheckpoint({
				sessionId,
				checkpointRunCount: latestCheckpoint.runCount,
				cwd,
			})
			return { cwd, diffs }
		} finally {
			await tempHost?.dispose("getRunChanges")
		}
	}

	private async loadLatestCheckpointComparison(): Promise<CheckpointComparison | undefined> {
		return this.loadCheckpointComparison()
	}

	private buildCheckpointChangesSummary(
		comparison:
			| {
					checkpointRunCount: number
					cwd: string
					diffs: CompareCheckpointResult["diffs"]
			  }
			| undefined,
	): LatestChangesSummary {
		if (!comparison || comparison.diffs.length === 0) {
			return LatestChangesSummary.create({
				files: [],
				totalAdded: 0,
				totalRemoved: 0,
				checkpointRunCount: comparison?.checkpointRunCount ?? 0,
			})
		}
		const built = buildChangedFileSummaries(comparison.diffs, comparison.cwd)
		const totalAdded = built.reduce((sum, file) => sum + file.addedLines, 0)
		const totalRemoved = built.reduce((sum, file) => sum + file.removedLines, 0)
		return LatestChangesSummary.create({
			files: built.map((file) =>
				ChangedFileSummary.create({
					filePath: file.filePath,
					relativePath: file.relativePath,
					addedLines: file.addedLines,
					removedLines: file.removedLines,
					status: file.status,
				}),
			),
			totalAdded,
			totalRemoved,
			checkpointRunCount: comparison.checkpointRunCount,
		})
	}

	async getCheckpointChangesSummary(input?: {
		checkpointRunCount?: number
		messageTs?: number
	}): Promise<LatestChangesSummary> {
		try {
			const resolvedRunCount = this.resolveCheckpointRunCountForSummary(input)
			if (input?.messageTs !== undefined && input.messageTs > 0 && resolvedRunCount === undefined) {
				return LatestChangesSummary.create({ files: [], totalAdded: 0, totalRemoved: 0, checkpointRunCount: 0 })
			}
			const comparison = await this.loadCheckpointComparison(resolvedRunCount)
			return this.buildCheckpointChangesSummary(comparison)
		} catch (error) {
			Logger.debug(`[SdkController] Failed to summarize checkpoint changes: ${error}`)
			return LatestChangesSummary.create({ files: [], totalAdded: 0, totalRemoved: 0, checkpointRunCount: 0 })
		}
	}

	async getLatestCheckpointChangesSummary(): Promise<LatestChangesSummary> {
		try {
			const comparison = await this.loadLatestCheckpointComparison()
			return this.buildCheckpointChangesSummary(comparison)
		} catch (error) {
			Logger.debug(`[SdkController] Failed to summarize latest checkpoint changes: ${error}`)
			return LatestChangesSummary.create({ files: [], totalAdded: 0, totalRemoved: 0, checkpointRunCount: 0 })
		}
	}

	async openCheckpointFileDiff(filePath: string, checkpointRunCount: number): Promise<void> {
		const comparison = await this.loadLatestCheckpointComparison()
		if (!comparison) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "No checkpoint was taken for this task. Checkpoints require the workspace to be a git repository.",
			})
			return
		}
		if (comparison.checkpointRunCount !== checkpointRunCount) {
			Logger.debug(
				`[SdkController] Stale checkpoint run count for file diff (${checkpointRunCount} vs ${comparison.checkpointRunCount})`,
			)
		}
		const diff = comparison.diffs.find((entry) => entry.filePath === filePath)
		if (!diff) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "That file is not part of the latest PlinyCode changes.",
			})
			return
		}
		const relativePath = buildChangedFileSummaries([diff], comparison.cwd)[0]?.relativePath ?? path.basename(filePath)
		await HostProvider.diff.openDiff({
			path: diff.filePath,
			leftContent: diff.leftContent,
			rightContent: diff.rightContent,
			title: `${relativePath} (PlinyCode changes)`,
		})
	}

	/**
	 * "View Changes" on the completion row: opens a multi-file diff of
	 * everything that changed between the latest checkpoint — snapshotted when
	 * the user's last message started this run — and the current working tree.
	 */
	async viewLatestCheckpointChanges(): Promise<void> {
		const comparison = await this.loadLatestCheckpointComparison()
		const diffs = comparison?.diffs
		if (diffs === undefined) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "No checkpoint was taken for this task. Checkpoints require the workspace to be a git repository.",
			})
			return
		}
		if (diffs.length === 0) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "No file changes found since your last message.",
			})
			return
		}

		await HostProvider.diff.openMultiFileDiff({
			title: "Changes since your last message",
			diffs: diffs.map((diff) => ({
				filePath: diff.filePath,
				leftContent: diff.leftContent,
				rightContent: diff.rightContent,
			})),
		})
	}
}
