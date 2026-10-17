/**
 * The task header's worktree actions (docs/task-worktrees.md#bringing-the-work-back):
 * Apply, Create PR and Remove worktree for a "Run in worktree" conversation.
 * Each asks in a modal first and reports what it did as an info row in the
 * chat; a refusal is an error message and changes nothing.
 */
import { existsSync } from "node:fs"
import type { HistoryItem, TaskWorktree } from "@shared/HistoryItem"
import type { Provider } from "@/services/devops-mcp/server/providers/types"
import type { RepoContext } from "@/services/devops-mcp/server/repo"
import {
	applyWorktreeToSource,
	branchMergeState,
	changedPaths,
	commitAll,
	commitSubjects,
	currentBranch,
	pushBranch,
	removeTaskWorktree,
	WorktreeActionError,
	worktreeBase,
} from "@/services/git/worktree-merge"

type WorktreeActionKind = "apply" | "create_pr" | "remove"

export function isWorktreeActionKind(value: string): value is WorktreeActionKind {
	return value === "apply" || value === "create_pr" || value === "remove"
}

/** What the actions need from the editor and the controller; `worktreeAction` wires the real ones. */
export interface WorktreeActionDeps {
	getHistoryItem(taskId: string): Promise<HistoryItem | undefined>
	/** Whether the conversation is running, on screen or in the background. */
	isRunning(taskId: string): boolean
	/** A modal dialog: resolves to the chosen item, or undefined when the user cancelled. */
	confirm(message: string, detail: string, items: string[]): Promise<string | undefined>
	showError(message: string): Promise<void>
	/** An info row in the conversation's chat. */
	emitRow(taskId: string, text: string): void
	setWorktree(taskId: string, worktree: TaskWorktree): Promise<void>
	/** After a removal: moves the conversation, when it is on screen, out of the removed folder. */
	afterRemoved(taskId: string): Promise<void>
	/** The DevOps server's view of the repository at `cwd`; throws when the server does not work with it. */
	openRepo(cwd: string): Promise<{ ctx: RepoContext; provider: Provider }>
	now?(): number
}

const MAX_LISTED = 20

function fileList(files: string[]): string {
	const shown = files.slice(0, MAX_LISTED).map((file) => `- ${file}`)
	if (files.length > MAX_LISTED) shown.push(`- … and ${files.length - MAX_LISTED} more`)
	return shown.join("\n")
}

/** The conversation title as a one-line commit message and pull request title. */
export function worktreeCommitTitle(title: string | undefined, branch: string): string {
	const line = (title ?? "")
		.split(/\r?\n/)
		.find((l) => l.trim())
		?.replace(/\s+/g, " ")
		.trim()
	if (!line) return `Changes from ${branch}`
	return line.length > 72 ? `${line.slice(0, 71).trimEnd()}…` : line
}

/** Runs one worktree action for the conversation `taskId`; every failure ends up in `showError`. */
export async function runWorktreeAction(deps: WorktreeActionDeps, taskId: string, action: WorktreeActionKind): Promise<void> {
	try {
		const item = await deps.getHistoryItem(taskId)
		const worktree = item?.worktree
		if (!item || !worktree) {
			throw new WorktreeActionError("This conversation does not run in a worktree of its own.")
		}
		if (worktree.removedTs) {
			throw new WorktreeActionError(`The worktree of ${worktree.branch} was already removed.`)
		}
		if (deps.isRunning(taskId)) {
			throw new WorktreeActionError("The conversation is still running. Wait for it to finish, or cancel it, first.")
		}
		if (action !== "remove" && !existsSync(worktree.path)) {
			throw new WorktreeActionError(`The worktree ${worktree.path} no longer exists.`)
		}
		if (action === "apply") {
			await apply(deps, taskId, worktree)
		} else if (action === "create_pr") {
			await createPr(deps, taskId, item, worktree)
		} else {
			await remove(deps, taskId, worktree)
		}
	} catch (error) {
		await deps.showError(error instanceof Error ? error.message : String(error))
	}
}

async function apply(deps: WorktreeActionDeps, taskId: string, worktree: TaskWorktree): Promise<void> {
	const base = await worktreeBase(worktree)
	const choice = await deps.confirm(
		`Apply the changes of ${worktree.branch} to ${worktree.repoRoot}?`,
		`The worktree's commits since ${base.slice(0, 8)} and its uncommitted changes are applied to your checkout and staged there. Nothing is committed. If they do not apply cleanly, nothing is changed.`,
		["Apply"],
	)
	if (choice !== "Apply") return
	const { files } = await applyWorktreeToSource(worktree)
	deps.emitRow(
		taskId,
		`Applied the worktree's changes to ${worktree.repoRoot}. ${files.length} file(s) are staged there, not committed:\n\n${fileList(files)}`,
	)
}

async function createPr(deps: WorktreeActionDeps, taskId: string, item: HistoryItem, worktree: TaskWorktree): Promise<void> {
	let repo: { ctx: RepoContext; provider: Provider }
	try {
		repo = await deps.openRepo(worktree.path)
	} catch (error) {
		throw new WorktreeActionError(
			`PlinyCode's DevOps server does not work with this repository, so it cannot open a pull request: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	const { ctx, provider } = repo
	const branch = worktree.branch
	if ((await currentBranch(worktree.path)) !== branch) {
		throw new WorktreeActionError(`The worktree ${worktree.path} is no longer on ${branch}.`)
	}
	const [target, existing, dirty, base] = await Promise.all([
		provider.defaultBranch(),
		provider.findOpenPr(branch),
		changedPaths(worktree.path),
		worktreeBase(worktree),
	])
	const title = worktreeCommitTitle(item.task, branch)
	if (dirty.length === 0 && (await commitSubjects(worktree.path, base)).length === 0) {
		throw new WorktreeActionError(`${branch} has no changes since ${base.slice(0, 8)}, so there is nothing to propose.`)
	}
	const steps = [
		...(dirty.length > 0 ? [`The ${dirty.length} uncommitted change(s) in the worktree are committed as "${title}".`] : []),
		`${branch} is pushed to ${ctx.remoteName}`,
	]
	const label = existing ? "Push" : "Create PR"
	const choice = await deps.confirm(
		existing
			? `${branch} already has pull request #${existing.id}. Push the worktree's work to it?`
			: `Open a pull request from ${branch} into ${target}?`,
		`${steps.join(" ")}${existing ? "." : `, and a draft pull request is opened on ${provider.kind === "ado" ? "Azure DevOps" : "GitHub"}.`}`,
		[label],
	)
	if (choice !== label) return
	await commitAll(worktree.path, title)
	await pushBranch(worktree.path, ctx.remoteName, branch)
	if (existing) {
		deps.emitRow(taskId, `Pushed ${branch} to ${ctx.remoteName}; pull request #${existing.id} is updated: ${existing.url}`)
		return
	}
	const subjects = await commitSubjects(worktree.path, base)
	const body = [
		`Changes made in the PlinyCode conversation "${title}", on the branch \`${branch}\`.`,
		...(subjects.length > 0 ? ["", "Commits:", ...subjects.map((s) => `- ${s}`)] : []),
	]
		.join("\n")
		.slice(0, provider.maxBodyLength)
	const pr = await provider.createPr(title, body, branch, target, true)
	deps.emitRow(taskId, `Opened draft pull request #${pr.id} from ${branch} into ${target}: ${pr.url}`)
}

interface RemovalOptions {
	/** What happens to the conversation, for the modal's details. */
	note: string
	/** Never offer to delete the branch (a CI Board worktree's branch is the pull request's). */
	keepBranch?: boolean
}

/** The modal for Remove worktree: its message, details and the choices it offers. */
export function removalPrompt(
	worktree: TaskWorktree,
	state: { exists: boolean; dirty: string[]; merged: boolean; unmerged: number; into: string; branchMissing?: boolean },
	options: RemovalOptions,
): { message: string; detail: string; choices: Record<string, { force: boolean; deleteBranch: boolean }> } {
	const force = state.dirty.length > 0
	const message = !state.exists
		? `The worktree folder ${worktree.path} is already gone. Forget it?`
		: force
			? `The worktree ${worktree.path} has ${state.dirty.length} uncommitted change(s). Remove it anyway and discard them?`
			: `Remove the worktree ${worktree.path}?`
	const verb = force ? "Discard and remove" : "Remove"
	if (options.keepBranch || state.branchMissing || state.merged) {
		const branchNote = state.branchMissing
			? ""
			: options.keepBranch
				? ` The branch ${worktree.branch} is kept.`
				: ` The branch ${worktree.branch} is merged into ${state.into}, so it is deleted too.`
		return {
			message,
			detail: `${options.note}${branchNote}`,
			choices: { [verb]: { force, deleteBranch: !options.keepBranch && !state.branchMissing } },
		}
	}
	return {
		message,
		detail: `${options.note} The branch ${worktree.branch} has ${state.unmerged} commit(s) that ${state.into} does not; keep it unless you are done with them.`,
		choices: {
			[`${verb}, keep branch`]: { force, deleteBranch: false },
			[`${verb} and delete branch`]: { force, deleteBranch: true },
		},
	}
}

/**
 * Asks in a modal (see `removalPrompt`) and removes the worktree as chosen.
 * Undefined when the user cancelled; the result line otherwise.
 */
export async function confirmAndRemoveWorktree(
	confirm: WorktreeActionDeps["confirm"],
	worktree: TaskWorktree,
	options: RemovalOptions,
): Promise<string | undefined> {
	const exists = existsSync(worktree.path)
	const dirty = exists ? await changedPaths(worktree.path) : []
	const merge = await branchMergeState(worktree.repoRoot, worktree.branch)
	const prompt = removalPrompt(worktree, { exists, dirty, ...merge, branchMissing: merge.missing }, options)
	const choice = await confirm(prompt.message, prompt.detail, Object.keys(prompt.choices))
	const picked = choice ? prompt.choices[choice] : undefined
	if (!picked) return undefined
	const { branchDeleted } = await removeTaskWorktree(worktree, picked)
	return `Removed the worktree ${worktree.path}.${branchDeleted ? ` The branch ${worktree.branch} was deleted.` : merge.missing ? "" : ` The branch ${worktree.branch} is kept.`}`
}

async function remove(deps: WorktreeActionDeps, taskId: string, worktree: TaskWorktree): Promise<void> {
	const result = await confirmAndRemoveWorktree(deps.confirm, worktree, {
		note: `The conversation keeps its history and continues in ${worktree.repoRoot}.`,
	})
	if (!result) return
	await deps.setWorktree(taskId, { ...worktree, removedTs: deps.now?.() ?? Date.now() })
	await deps.afterRemoved(taskId)
	deps.emitRow(taskId, result)
}
