import path from "node:path"
import { resolveClineDataDir } from "@plinycode/shared/storage"
import * as vscode from "vscode"
import { workspaceRefFromWindow } from "@/core/workspace/workspace-identity"
import { HostProvider } from "@/hosts/host-provider"
import { workspaceGitDiscoveryPaths } from "@/hosts/vscode/vscode-git-repository-roots"
import { ShowMessageType } from "@/shared/proto/index.host"
import { Logger } from "@/shared/services/Logger"
import { setCiBoard } from "../builtin-mcp-registry"
import { CiAutoRunner, type CiAutoStartResult } from "../ci-board/ci-auto-runner"
import { CiBoard } from "../ci-board/ci-board"
import { CiBoardStore } from "../ci-board/ci-board-store"
import type { CiTriageMode, CompleteFn } from "../ci-board/ci-triage"
import type { CiTransition } from "../ci-board/types"
import type { ProviderCache } from "../ci-watch/ci-watch-source"
import { loadContext, type Remote, sameRepository } from "../server/repo"

const SETTING_POLL = "plinycode.ci.board.pollSeconds"
const SETTING_HIDDEN_POLL = "plinycode.ci.board.hiddenPollSeconds"
const SETTING_NOTIFY = "plinycode.ci.board.notify"
const SETTING_MAX_PRS = "plinycode.ci.board.maxPrsPerRepo"
const SETTING_WORKTREE_ROOT = "plinycode.ci.worktreeRoot"
const SETTING_TRIAGE = "plinycode.ci.board.triage"
const SETTING_AUTO_ATTEMPTS = "plinycode.ci.board.autoWatch.maxAttempts"
const SETTING_AUTO_CONCURRENT = "plinycode.ci.board.autoWatch.maxConcurrentRuns"
const MIN_POLL_SECONDS = 30
/** Auto-watch runs of one action on one pull request before it stops until the PR turns green. */
const MAX_RUNS_PER_ITEM = 3
const OPEN_BOARD = "Open CI Board"
const OPEN_CONVERSATION = "Open conversation"

/** What the board needs from the editor and the controller; the extension wires these. */
export interface CiBoardUi {
	openBoard(): Promise<void>
	/** Shows the Pipelines view; its run notifications offer it. */
	openPipelines?(): Promise<void>
	runAction(targetId: string, itemKey: string, actionId: string): Promise<void>
	/** Starts an auto-watch run in the background. */
	startAutoRun?(targetId: string, itemKey: string, actionId: string): Promise<CiAutoStartResult>
	/** Whether a conversation is still running, on screen or in the background. */
	isConversationActive?(conversationId: string): boolean
	/** Free background slots. */
	backgroundFreeSlots?(): number
	onBackgroundReleased?(listener: (conversationId: string) => void): () => void
	openConversation?(conversationId: string): Promise<void>
	/** One request to the free utility model, for failure triage. */
	complete?: CompleteFn
}

const config = () => vscode.workspace.getConfiguration()

function timings() {
	const seconds = (key: string, fallback: number) => Math.max(MIN_POLL_SECONDS, config().get<number>(key, fallback)) * 1000
	return { pollMs: seconds(SETTING_POLL, 60), hiddenPollMs: seconds(SETTING_HIDDEN_POLL, 180) }
}

function triageMode(): CiTriageMode {
	const mode = config().get<string>(SETTING_TRIAGE, "auto")
	return mode === "onDemand" || mode === "off" ? mode : "auto"
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)))

/**
 * Builds the window's CI board in the extension host: the window's workspace
 * names the board, the editor's sign-in reads CI (without ever prompting), a
 * free model triages failures, auto-watch runs fixes, and failures turn into
 * notifications.
 */
export class CiBoardHost implements vscode.Disposable {
	private board?: CiBoard
	private autoRunner?: CiAutoRunner
	private readonly disposables: vscode.Disposable[] = []

	private constructor(
		private readonly providers: ProviderCache,
		private readonly ui: CiBoardUi | undefined,
	) {}

	static start(providers: ProviderCache, ui?: CiBoardUi): CiBoardHost {
		const host = new CiBoardHost(providers, ui)
		host.init().catch((error) => Logger.error("[CiBoard] Failed to start:", error))
		return host
	}

	private async workspacePaths(): Promise<{ paths: string[]; workspaceFile?: string }> {
		const { paths, workspaceFile } = await HostProvider.workspace.getWorkspacePaths({})
		return { paths: paths ?? [], workspaceFile }
	}

	private async init(): Promise<void> {
		const window = workspaceRefFromWindow(await this.workspacePaths())
		const ui = this.ui
		const board = new CiBoard({
			store: new CiBoardStore(path.join(resolveClineDataDir(), "ci-board.json")),
			// An empty window still gets a board for pull request links; it just cannot run actions.
			workspacePath: window?.path ?? "",
			providerFor: (remote) => this.providers.forRemote(remote),
			resolveCheckout: (remote) => this.resolveCheckout(remote),
			maxPrsPerRepo: () => Math.max(1, config().get<number>(SETTING_MAX_PRS, 30)),
			worktreeFolder: () => config().get<string>(SETTING_WORKTREE_ROOT, ""),
			poller: { timings: timings() },
			complete: ui?.complete,
			triageMode,
		})
		this.board = board
		setCiBoard(board)
		board.onTransition((transition) => void this.notify(transition))
		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => void board.rescanCheckouts()),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration(SETTING_POLL) || event.affectsConfiguration(SETTING_HIDDEN_POLL)) {
					board.setTimings(timings())
				}
				if (event.affectsConfiguration(SETTING_TRIAGE) || event.affectsConfiguration("plinycode.ci.board.autoWatch")) {
					board.touch()
				}
			}),
		)
		await board.init()
		if (ui?.startAutoRun && ui.isConversationActive && ui.backgroundFreeSlots && ui.onBackgroundReleased) {
			const { startAutoRun, isConversationActive, backgroundFreeSlots, onBackgroundReleased } = ui
			this.autoRunner = new CiAutoRunner({
				board,
				start: (targetId, key, actionId) => startAutoRun(targetId, key, actionId),
				isActive: (id) => isConversationActive(id),
				freeSlots: () => backgroundFreeSlots(),
				onBackgroundReleased: (listener) => onBackgroundReleased(listener),
				notify: (kind, message, conversationId) => void this.notifyAuto(kind, message, conversationId),
				settings: () => ({
					maxAttemptsPerHead: clamp(config().get<number>(SETTING_AUTO_ATTEMPTS, 2), 1, 5),
					maxRunsPerItem: MAX_RUNS_PER_ITEM,
					maxConcurrent: clamp(config().get<number>(SETTING_AUTO_CONCURRENT, 1), 1, 2),
				}),
			})
			board.setAutoStates((key) => this.autoRunner?.state(key))
			this.autoRunner.evaluate()
		}
	}

	/** The open folder whose `origin` is `remote`. */
	private async resolveCheckout(remote: Remote): Promise<string | undefined> {
		const { paths } = await this.workspacePaths()
		for (const folder of workspaceGitDiscoveryPaths(paths)) {
			try {
				const ctx = await loadContext(folder)
				if (sameRepository(ctx.remote, remote)) {
					return ctx.root
				}
			} catch {
				// not a repository with a supported remote
			}
		}
		return undefined
	}

	private async notify(transition: CiTransition): Promise<void> {
		const board = this.board
		const target = board?.target(transition.targetId)
		const item = board?.item(transition.targetId, transition.itemKey)
		if (!board || !target || !item || transition.kind === "recovered" || !config().get<boolean>(SETTING_NOTIFY, true)) {
			return
		}
		// Auto-watch tells the user itself what it starts and what it leaves to them.
		if (target.autoWatch && this.autoRunner) {
			return
		}
		const name = item.pr ? `PR #${item.pr.id} (${item.pr.sourceBranch})` : `branch ${item.branch}`
		const message =
			transition.kind === "failed"
				? `CI failed on ${name}: ${transition.pipelines.join(", ")}.`
				: `${name} has merge conflicts with ${item.pr?.targetBranch ?? "its target branch"}.`
		const action = target.actions.find((a) => a.id === (transition.kind === "conflict" ? "fix-conflicts" : "fix-ci"))
		const runnable = action && !board.runBlockedReason(target, item) && this.ui
		const items = [OPEN_BOARD, ...(runnable ? [action.label] : [])]
		const { selectedOption } = await HostProvider.window.showMessage({
			type: ShowMessageType.WARNING,
			message,
			options: { items },
		})
		if (selectedOption === OPEN_BOARD) {
			await this.ui?.openBoard()
		} else if (runnable && selectedOption === action.label) {
			await this.ui?.runAction(target.id, item.key, action.id)
		}
	}

	private async notifyAuto(kind: "started" | "needs_you" | "capped", message: string, conversationId?: string): Promise<void> {
		if (!config().get<boolean>(SETTING_NOTIFY, true)) {
			return
		}
		const items = [...(conversationId ? [OPEN_CONVERSATION] : []), OPEN_BOARD]
		const { selectedOption } = await HostProvider.window.showMessage({
			type: kind === "started" ? ShowMessageType.INFORMATION : ShowMessageType.WARNING,
			message,
			options: { items },
		})
		if (selectedOption === OPEN_BOARD) {
			await this.ui?.openBoard()
		} else if (selectedOption === OPEN_CONVERSATION && conversationId) {
			await this.ui?.openConversation?.(conversationId)
		}
	}

	dispose(): void {
		for (const d of this.disposables) d.dispose()
		this.autoRunner?.dispose()
		this.board?.setAutoStates(undefined)
		this.board?.dispose()
		setCiBoard(undefined)
	}
}
