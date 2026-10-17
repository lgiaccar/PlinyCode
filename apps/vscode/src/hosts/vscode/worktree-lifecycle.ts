import { promises as fs } from "node:fs"
import path from "node:path"
import { resolveClineDataDir } from "@plinycode/shared/storage"
import * as vscode from "vscode"
import type { Controller } from "@/core/controller"
import { confirmAndRemoveWorktree, runWorktreeAction } from "@/core/controller/task/worktree-action-runner"
import { worktreeActionDeps } from "@/core/controller/task/worktreeAction"
import { CiBoardStore } from "@/services/devops-mcp/ci-board/ci-board-store"
import { collectWorktreeGarbage, findPlinyWorktrees, type PlinyWorktree } from "@/services/git/worktree-gc"
import { Logger } from "@/shared/services/Logger"

/**
 * Worktree cleanup and the "Manage Worktrees" command (docs/task-worktrees.md#cleanup).
 * The cleanup runs in the background a few minutes after startup and then
 * daily; a stamp in the shared data folder keeps several windows from all
 * running it on the same day.
 */

const FIRST_RUN_DELAY_MS = 5 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** Another window's pass this recent counts as today's. */
const MIN_GAP_MS = 20 * 60 * 60 * 1000
const DEFAULT_KEEP_DAYS = 7

const config = () => vscode.workspace.getConfiguration("plinycode")

/** `plinycode.worktrees.keepDays`; 0 turns the cleanup off. */
function keepDays(): number {
	const days = config().get<number>("worktrees.keepDays", DEFAULT_KEEP_DAYS)
	return typeof days === "number" && Number.isFinite(days) ? Math.max(0, days) : DEFAULT_KEEP_DAYS
}

function configuredRoots(): string[] {
	return [config().get<string>("worktrees.root", ""), config().get<string>("ci.worktreeRoot", "")].filter(
		(root): root is string => typeof root === "string" && root.trim().length > 0,
	)
}

async function scanInput(controller: Controller) {
	const links = await new CiBoardStore(path.join(resolveClineDataDir(), "ci-board.json")).allLinks()
	return {
		conversations: await controller.listConversationWorktrees(),
		ciLinks: links.map(({ conversationId, worktree, startedTs }) => ({ conversationId, worktree, startedTs })),
		configuredRoots: configuredRoots(),
	}
}

/** True when no window ran the cleanup in the last 20 hours; records this run. */
async function claimDailyRun(now: number): Promise<boolean> {
	const stamp = path.join(resolveClineDataDir(), "worktree-cleanup.json")
	try {
		const last = Number(JSON.parse(await fs.readFile(stamp, "utf8"))?.lastRunTs)
		if (Number.isFinite(last) && now - last < MIN_GAP_MS) {
			return false
		}
	} catch {
		// No stamp yet, or an unreadable one: run.
	}
	await fs.mkdir(path.dirname(stamp), { recursive: true }).catch(() => undefined)
	await fs.writeFile(stamp, JSON.stringify({ lastRunTs: now }), "utf8").catch(() => undefined)
	return true
}

const openFolders = () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)

/** Marks the conversations of a removed worktree, so their header and a resume know. */
async function markRemoved(controller: Controller, worktree: PlinyWorktree): Promise<void> {
	if (worktree.kind !== "conversation") {
		return
	}
	for (const id of worktree.conversationIds) {
		const record = (await controller.getHistoryItem(id))?.worktree
		if (record) {
			await controller.setTaskWorktree(id, { ...record, removedTs: Date.now() })
		}
	}
}

async function runCleanup(controller: Controller): Promise<void> {
	const days = keepDays()
	if (!(days > 0) || !(await claimDailyRun(Date.now()))) {
		return
	}
	const outcomes = await collectWorktreeGarbage({
		keepDays: days,
		isActive: (id) => controller.conversationActivity(id) !== "idle",
		openFolders: openFolders(),
		scan: () => scanInput(controller),
		log: (message) => Logger.log(`[WorktreeCleanup] ${message}`),
		onRemoved: (worktree) => markRemoved(controller, worktree),
	})
	const removed = outcomes.filter((outcome) => outcome.removed).length
	Logger.log(`[WorktreeCleanup] Checked ${outcomes.length} PlinyCode worktree(s), removed ${removed}.`)
}

const modal = async (message: string, detail: string, items: string[]) =>
	vscode.window.showWarningMessage(message, { modal: true, detail }, ...items)

function ago(ts: number): string {
	if (!ts) return "activity unknown"
	const days = Math.floor((Date.now() - ts) / DAY_MS)
	return days < 1 ? "active today" : `idle ${days} day${days === 1 ? "" : "s"}`
}

/** The Manage Worktrees quick pick: every PlinyCode worktree, with open and remove actions. */
async function manageWorktrees(controller: Controller, openConversation: (id: string) => Promise<void>): Promise<void> {
	const input = await scanInput(controller)
	const worktrees = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: "Finding PlinyCode worktrees" },
		() => findPlinyWorktrees(input),
	)
	if (worktrees.length === 0) {
		void vscode.window.showInformationMessage(
			"PlinyCode has no worktrees: none of its conversations or CI Board runs has one.",
		)
		return
	}
	const titles = new Map(input.conversations.map((c) => [c.id, c.title]))
	const picked = await vscode.window.showQuickPick(
		worktrees.map((worktree) => {
			const title = worktree.conversationIds.map((id) => titles.get(id)).find(Boolean)
			return {
				label: `$(git-branch) ${worktree.branch ?? path.basename(worktree.path)}`,
				description: [
					worktree.kind === "ci" ? "CI Board" : "conversation",
					worktree.dirty ? "uncommitted changes" : "clean",
					worktree.conversationIds.length === 0 ? "conversation deleted" : ago(worktree.lastActivityTs),
				].join(" · "),
				detail: title ? `${worktree.path} · ${title}` : worktree.path,
				worktree,
			}
		}),
		{ placeHolder: "PlinyCode worktrees: pick one to open or remove", matchOnDescription: true, matchOnDetail: true },
	)
	if (!picked) {
		return
	}
	const { worktree } = picked
	const conversationId = worktree.conversationIds[0]
	const OPEN = "Open in New Window"
	const CONVERSATION = "Open Conversation"
	const REMOVE = "Remove Worktree"
	const action = await vscode.window.showQuickPick([OPEN, ...(conversationId ? [CONVERSATION] : []), REMOVE], {
		placeHolder: worktree.path,
	})
	try {
		if (action === OPEN) {
			await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(worktree.path), { forceNewWindow: true })
		} else if (action === CONVERSATION && conversationId) {
			await openConversation(conversationId)
		} else if (action === REMOVE) {
			if (worktree.kind === "conversation" && conversationId) {
				// The conversation's own Remove worktree: also marks it and moves it out when it is on screen.
				await runWorktreeAction(worktreeActionDeps(controller), conversationId, "remove")
				return
			}
			const result = await confirmAndRemoveWorktree(
				modal,
				{ repoRoot: worktree.repoRoot, branch: worktree.branch ?? "", path: worktree.path },
				{
					note:
						worktree.kind === "ci"
							? "The CI Board makes a new one the next time it runs an action on this pull request."
							: "Its conversation was deleted.",
					keepBranch: worktree.kind === "ci" || !worktree.branch,
				},
			)
			if (result) {
				void vscode.window.showInformationMessage(result)
			}
		}
	} catch (error) {
		void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
	}
}

interface WorktreeLifecycleOptions {
	commandId: string
	getController(): Controller | undefined
	openConversation(conversationId: string): Promise<void>
}

/** Registers the Manage Worktrees command and schedules the cleanup. */
export function registerWorktreeLifecycle(context: vscode.ExtensionContext, options: WorktreeLifecycleOptions): void {
	let running = false
	const run = () => {
		const controller = options.getController()
		if (running || !controller) {
			return
		}
		running = true
		runCleanup(controller)
			.catch((error) => Logger.error("[WorktreeCleanup] Cleanup failed:", error))
			.finally(() => {
				running = false
			})
	}
	const first = setTimeout(run, FIRST_RUN_DELAY_MS)
	const daily = setInterval(run, DAY_MS)
	first.unref?.()
	daily.unref?.()
	context.subscriptions.push(
		new vscode.Disposable(() => {
			clearTimeout(first)
			clearInterval(daily)
		}),
		vscode.commands.registerCommand(options.commandId, async () => {
			const controller = options.getController()
			if (!controller) {
				return
			}
			try {
				await manageWorktrees(controller, options.openConversation)
			} catch (error) {
				void vscode.window.showErrorMessage(
					`Could not list the worktrees: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}),
	)
}
