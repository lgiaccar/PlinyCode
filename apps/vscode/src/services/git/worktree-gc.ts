/**
 * Worktree cleanup (docs/task-worktrees.md#cleanup): finds the git worktrees
 * PlinyCode made, for conversations ("Run in worktree", branch `<user>/*`)
 * and for CI Board runs, and removes the clean ones whose conversation was
 * deleted or has been idle for `plinycode.worktrees.keepDays` days. A worktree
 * with uncommitted changes, the main checkout, a folder open in this window
 * and a worktree whose conversation is running are never removed. Branches
 * stay, except a conversation branch that is merged (`git branch -d`).
 */
import { existsSync, promises as fs } from "node:fs"
import path from "node:path"
import type { TaskWorktree } from "@shared/HistoryItem"
import { changedPaths } from "./worktree-merge"
import { git, isTaskBranch, listWorktrees, worktreeRoot } from "./worktrees"

const DAY_MS = 24 * 60 * 60 * 1000
/**
 * A worktree younger than this is never removed: a conversation's worktree is
 * created a moment before its history entry is written.
 */
const MIN_AGE_MS = 60 * 60 * 1000

/** What the cleanup needs to know about a conversation. */
export interface WorktreeConversation {
	id: string
	title?: string
	/** Last activity (ms since epoch). */
	ts: number
	worktree?: TaskWorktree
}

/** A CI Board run: the conversation it started and the folder it works in. */
export interface CiWorktreeLink {
	conversationId: string
	worktree: string
	startedTs: number
}

export interface PlinyWorktree {
	/** The main checkout of the repository. */
	repoRoot: string
	path: string
	branch?: string
	kind: "conversation" | "ci"
	/** The conversations that work in it and still exist. */
	conversationIds: string[]
	/** The latest activity of those conversations, or of the CI run (ms since epoch); 0 when unknown. */
	lastActivityTs: number
	/** Uncommitted changes, or a status that could not be read. */
	dirty: boolean
	/** When the folder was created (ms since epoch), when the file system says. */
	createdTs?: number
}

interface WorktreeScanInput {
	conversations: WorktreeConversation[]
	ciLinks: CiWorktreeLink[]
	/** `plinycode.worktrees.root` and `plinycode.ci.worktreeRoot`, as set (empty ones are ignored). */
	configuredRoots: string[]
}

const comparable = (p: string) => {
	const resolved = path.resolve(p).replace(/[\\/]+$/, "")
	return process.platform === "win32" ? resolved.toLowerCase() : resolved
}
const samePath = (a: string, b: string) => comparable(a) === comparable(b)
/** `child` is `parent` or inside it. */
const isWithin = (parent: string, child: string) => {
	const relative = path.relative(comparable(parent), comparable(child))
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * The PlinyCode-made worktrees of every repository PlinyCode knows from
 * conversation metadata and the CI Board's runs, under one of the worktree
 * folders (the configured ones and `<repository>.worktrees`).
 */
export async function findPlinyWorktrees(input: WorktreeScanInput): Promise<PlinyWorktree[]> {
	const starts = [
		...input.conversations.flatMap((c) => (c.worktree ? [c.worktree.repoRoot, c.worktree.path] : [])),
		...input.ciLinks.map((link) => link.worktree),
	]
	const repos = new Map<string, Awaited<ReturnType<typeof listWorktrees>>>()
	for (const start of starts) {
		if (!existsSync(start) || [...repos.values()].some((list) => list.some((w) => samePath(w.path, start)))) {
			continue
		}
		const list = await listWorktrees(start).catch(() => undefined)
		const main = list?.[0]
		if (list && main && !repos.has(comparable(main.path))) {
			repos.set(comparable(main.path), list)
		}
	}

	const known = new Map(input.conversations.map((c) => [c.id, c]))
	const roots = input.configuredRoots.map((root) => root.trim()).filter(Boolean)
	const found: PlinyWorktree[] = []
	for (const list of repos.values()) {
		const [main, ...others] = list
		const folders = [...roots.map((root) => worktreeRoot(main.path, root)), worktreeRoot(main.path)]
		for (const entry of others) {
			if (!folders.some((folder) => isWithin(folder, entry.path) && !samePath(folder, entry.path))) {
				continue
			}
			const links = input.ciLinks.filter((link) => samePath(link.worktree, entry.path))
			const kind = (await isTaskBranch(main.path, entry.branch)) ? "conversation" : links.length > 0 ? "ci" : undefined
			if (!kind || !existsSync(entry.path)) {
				continue
			}
			const conversations =
				kind === "conversation"
					? input.conversations.filter((c) => c.worktree && samePath(c.worktree.path, entry.path))
					: links.flatMap((link) => known.get(link.conversationId) ?? [])
			const activity = [
				...conversations.map((c) => c.ts),
				...(kind === "ci" ? links.map((link) => link.startedTs) : []),
			].filter((ts) => Number.isFinite(ts))
			const dirty = await changedPaths(entry.path).then(
				(paths) => paths.length > 0,
				() => true,
			)
			const stat = await fs.stat(entry.path).catch(() => undefined)
			const createdTs = stat ? stat.birthtimeMs || stat.ctimeMs : undefined
			found.push({
				repoRoot: main.path,
				path: entry.path,
				...(entry.branch ? { branch: entry.branch } : {}),
				kind,
				conversationIds: [...new Set(conversations.map((c) => c.id))],
				lastActivityTs: activity.length > 0 ? Math.max(...activity) : 0,
				dirty,
				...(createdTs ? { createdTs } : {}),
			})
		}
	}
	return found
}

interface VerdictContext {
	now: number
	keepDays: number
	/** Whether a conversation is running, on screen or in the background. */
	isActive(conversationId: string): boolean
	/** Folders open in this window; a worktree holding one is kept. */
	openFolders: string[]
}

type GcVerdict = { remove: boolean; reason: string }

/** Whether the cleanup removes `worktree`, and why (or why not). */
export function gcVerdict(worktree: PlinyWorktree, context: VerdictContext): GcVerdict {
	const keep = (reason: string) => ({ remove: false, reason })
	if (!(context.keepDays > 0)) {
		return keep("cleanup is off (plinycode.worktrees.keepDays is 0)")
	}
	if (worktree.dirty) {
		return keep("it has uncommitted changes")
	}
	if (context.openFolders.some((folder) => isWithin(worktree.path, folder) || isWithin(folder, worktree.path))) {
		return keep("it is open in this window")
	}
	if (worktree.conversationIds.some((id) => context.isActive(id))) {
		return keep("its conversation is running")
	}
	if (worktree.createdTs && context.now - worktree.createdTs < MIN_AGE_MS) {
		return keep("it was created less than an hour ago")
	}
	if (worktree.conversationIds.length === 0) {
		return { remove: true, reason: "its conversation was deleted" }
	}
	const idleDays = (context.now - worktree.lastActivityTs) / DAY_MS
	if (idleDays > context.keepDays) {
		return { remove: true, reason: `its conversation has been idle for ${Math.floor(idleDays)} days` }
	}
	return keep("its conversation was active recently")
}

/**
 * Removes a PlinyCode worktree with `git worktree remove` (never forced, so
 * git itself refuses one that became dirty), and its conversation branch
 * with `git branch -d` when the branch is merged. Returns git's error, if any.
 */
async function removePlinyWorktree(
	worktree: Pick<PlinyWorktree, "repoRoot" | "path" | "branch">,
): Promise<{ error?: string; branchDeleted: boolean }> {
	const removed = await git(worktree.repoRoot, ["worktree", "remove", worktree.path], 300_000)
	if (!removed.ok) {
		return { error: removed.stderr || "git worktree remove failed", branchDeleted: false }
	}
	const branchDeleted =
		(await isTaskBranch(worktree.repoRoot, worktree.branch)) &&
		(await git(worktree.repoRoot, ["branch", "-d", worktree.branch as string])).ok
	return { branchDeleted }
}

interface WorktreeGcDeps extends Omit<VerdictContext, "now"> {
	now?(): number
	scan(): Promise<WorktreeScanInput>
	log(message: string): void
	/** Called after a conversation's worktree was removed, to mark it in the conversation's record. */
	onRemoved?(worktree: PlinyWorktree): Promise<void>
}

interface GcOutcome {
	worktree: PlinyWorktree
	verdict: GcVerdict
	removed: boolean
	error?: string
}

/** One cleanup pass. Does nothing when `keepDays` is 0. */
export async function collectWorktreeGarbage(deps: WorktreeGcDeps): Promise<GcOutcome[]> {
	if (!(deps.keepDays > 0)) {
		return []
	}
	const now = deps.now?.() ?? Date.now()
	const outcomes: GcOutcome[] = []
	for (const worktree of await findPlinyWorktrees(await deps.scan())) {
		const verdict = gcVerdict(worktree, { ...deps, now })
		if (!verdict.remove) {
			outcomes.push({ worktree, verdict, removed: false })
			continue
		}
		const { error, branchDeleted } = await removePlinyWorktree(worktree)
		if (error) {
			deps.log(`Could not remove the worktree ${worktree.path} (${verdict.reason}): ${error}`)
			outcomes.push({ worktree, verdict, removed: false, error })
			continue
		}
		deps.log(
			`Removed the worktree ${worktree.path}${worktree.branch ? ` (${worktree.branch}${branchDeleted ? ", branch deleted" : ""})` : ""}: ${verdict.reason}.`,
		)
		await deps.onRemoved?.(worktree).catch((err) => deps.log(`Could not mark ${worktree.path} removed: ${String(err)}`))
		outcomes.push({ worktree, verdict, removed: true })
	}
	return outcomes
}
