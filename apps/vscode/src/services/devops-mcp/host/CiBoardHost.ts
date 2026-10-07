import path from "node:path"
import { resolveClineDataDir } from "@plinycode/shared/storage"
import * as vscode from "vscode"
import { workspaceRefFromWindow } from "@/core/workspace/workspace-identity"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/index.host"
import { Logger } from "@/shared/services/Logger"
import { setCiBoard } from "../builtin-mcp-registry"
import { CiBoard } from "../ci-board/ci-board"
import { CiBoardStore } from "../ci-board/ci-board-store"
import type { CiTransition } from "../ci-board/types"
import type { ProviderCache } from "../ci-watch/ci-watch-source"
import { loadContext, type Remote, sameRepository } from "../server/repo"

const SETTING_POLL = "plinycode.ci.board.pollSeconds"
const SETTING_HIDDEN_POLL = "plinycode.ci.board.hiddenPollSeconds"
const SETTING_NOTIFY = "plinycode.ci.board.notify"
const SETTING_MAX_PRS = "plinycode.ci.board.maxPrsPerRepo"
const SETTING_WORKTREE_ROOT = "plinycode.ci.worktreeRoot"
const MIN_POLL_SECONDS = 30
const OPEN_BOARD = "Open CI Board"

/** What the board's notifications can do; the extension wires these to the webview and the controller. */
export interface CiBoardUi {
	openBoard(): Promise<void>
	runAction(targetId: string, itemKey: string, actionId: string): Promise<void>
}

const config = () => vscode.workspace.getConfiguration()

function timings() {
	const seconds = (key: string, fallback: number) => Math.max(MIN_POLL_SECONDS, config().get<number>(key, fallback)) * 1000
	return { pollMs: seconds(SETTING_POLL, 60), hiddenPollMs: seconds(SETTING_HIDDEN_POLL, 180) }
}

/**
 * Builds the window's CI board in the extension host: the window's workspace
 * names the board, the editor's sign-in reads CI (without ever prompting), and
 * failures turn into notifications.
 */
export class CiBoardHost implements vscode.Disposable {
	private board?: CiBoard
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
		const board = new CiBoard({
			store: new CiBoardStore(path.join(resolveClineDataDir(), "ci-board.json")),
			// An empty window still gets a board for pull request links; it just cannot run actions.
			workspacePath: window?.path ?? "",
			providerFor: (remote) => this.providers.forRemote(remote),
			resolveCheckout: (remote) => this.resolveCheckout(remote),
			maxPrsPerRepo: () => Math.max(1, config().get<number>(SETTING_MAX_PRS, 30)),
			worktreeFolder: () => config().get<string>(SETTING_WORKTREE_ROOT, ""),
			poller: { timings: timings() },
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
			}),
		)
		await board.init()
	}

	/** The open folder whose `origin` is `remote`. */
	private async resolveCheckout(remote: Remote): Promise<string | undefined> {
		for (const folder of (await this.workspacePaths()).paths) {
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
		const name = item.pr ? `PR #${item.pr.id} (${item.pr.sourceBranch})` : `branch ${item.branch}`
		const message =
			transition.kind === "failed"
				? `CI failed on ${name}: ${transition.pipelines.join(", ")}.`
				: `${name} has merge conflicts with ${item.pr?.targetBranch ?? "its target branch"}.`
		const action = target.actions[0]
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

	dispose(): void {
		for (const d of this.disposables) d.dispose()
		this.board?.dispose()
		setCiBoard(undefined)
	}
}
