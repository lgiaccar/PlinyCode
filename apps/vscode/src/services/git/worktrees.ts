/**
 * Git worktrees: working copies next to the repository, so a branch can be
 * worked on without touching the user's checkout. The CI Board gives each pull
 * request's branch one (`ensureWorktree`), and a conversation started with
 * "Run in worktree" gets a fresh branch of its own (`ensureTaskWorktree`).
 */
import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"
import type { TaskWorktree } from "@shared/HistoryItem"

interface GitResult {
	ok: boolean
	stdout: string
	stderr: string
	/** The git executable could not be started (not installed, or not on PATH). */
	missing?: boolean
}

export function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", cwd, ...args],
			{ windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs },
			(error, stdout, stderr) =>
				resolve({
					ok: !error,
					stdout: String(stdout).trim(),
					stderr: String(stderr).trim(),
					...((error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? { missing: true } : {}),
				}),
		)
	})
}

async function gitOrThrow(cwd: string, args: string[], what: string): Promise<string> {
	const result = await git(cwd, args)
	if (!result.ok) {
		throw new Error(`Could not ${what}: ${result.stderr || `git ${args.join(" ")} failed`}`)
	}
	return result.stdout
}

const MAX_SLUG = 40

/** A folder name for `branch`: path-safe, short enough for Windows, and distinct per branch. */
export function worktreeSlug(branch: string): string {
	const safe = branch.replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "branch"
	if (safe === branch && safe.length <= MAX_SLUG) {
		return safe
	}
	const hash = createHash("sha1").update(branch).digest("hex").slice(0, 8)
	return `${safe.slice(0, MAX_SLUG)}-${hash}`
}

/** `<parent>/<repo>.worktrees`, unless the user set another folder. */
export function worktreeRoot(repoRoot: string, configured?: string): string {
	const custom = configured?.trim()
	if (custom) {
		return path.join(custom, path.basename(repoRoot))
	}
	return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}.worktrees`)
}

interface WorktreeInfo {
	path: string
	/** Short branch name; undefined when detached. */
	branch?: string
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
	const out = await gitOrThrow(repoRoot, ["worktree", "list", "--porcelain"], "list the worktrees")
	const worktrees: WorktreeInfo[] = []
	let current: WorktreeInfo | undefined
	for (const line of out.split(/\r?\n/)) {
		if (line.startsWith("worktree ")) {
			current = { path: path.normalize(line.slice("worktree ".length)) }
			worktrees.push(current)
		} else if (line.startsWith("branch ") && current) {
			current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "")
		}
	}
	return worktrees
}

export interface EnsuredWorktree {
	path: string
	/** The branch is checked out in the repository itself, so the run works there. */
	inPlace: boolean
	created: boolean
	/** Things the user and the agent should know, e.g. that the copy has local changes. */
	notes: string[]
}

interface EnsureWorktreeOptions {
	repoRoot: string
	remoteName: string
	branch: string
	/** Folder for new worktrees; see `worktreeRoot`. */
	root: string
}

/**
 * A working copy of `branch`, brought up to date with the remote when that is
 * safe: the repository itself when the branch is checked out there, an
 * existing worktree of the branch, or a new one under `root`.
 */
export async function ensureWorktree(options: EnsureWorktreeOptions): Promise<EnsuredWorktree> {
	const { repoRoot, remoteName, branch } = options
	const notes: string[] = []
	const current = (await git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout
	if (current === branch) {
		notes.push(`The branch is checked out in ${repoRoot}, so the run works there, beside any changes you have open.`)
		return { path: repoRoot, inPlace: true, created: false, notes }
	}

	const remoteRef = `refs/remotes/${remoteName}/${branch}`
	const fetched = await git(repoRoot, ["fetch", "--quiet", remoteName, `+refs/heads/${branch}:${remoteRef}`])
	if (!fetched.ok) {
		throw new Error(`Could not fetch '${branch}' from ${remoteName}: ${fetched.stderr || "git fetch failed"}`)
	}

	const existing = (await listWorktrees(repoRoot)).find((w) => w.branch === branch)
	if (existing) {
		await fastForward(existing.path, remoteName, branch, notes)
		return { path: existing.path, inPlace: false, created: false, notes }
	}

	const target = path.join(options.root, worktreeSlug(branch))
	if (existsSync(target)) {
		throw new Error(
			`${target} already exists but is not a worktree of '${branch}'. Remove it or set plinycode.ci.worktreeRoot.`,
		)
	}
	const hasLocal = (await git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok
	const args = hasLocal
		? ["worktree", "add", target, branch]
		: ["worktree", "add", "--track", "-b", branch, target, `${remoteName}/${branch}`]
	await gitOrThrow(repoRoot, args, `create a worktree for '${branch}'`)
	if (hasLocal) {
		await fastForward(target, remoteName, branch, notes)
	}
	if (existsSync(path.join(target, ".gitmodules"))) {
		const submodules = await git(target, ["submodule", "update", "--init", "--recursive"], 600_000)
		if (!submodules.ok) {
			notes.push(`Submodules could not be checked out: ${submodules.stderr}`)
		}
	}
	return { path: target, inPlace: false, created: true, notes }
}

/** Moves a clean working copy to the remote branch's commit; says why not otherwise. */
async function fastForward(dir: string, remoteName: string, branch: string, notes: string[]): Promise<void> {
	const status = await git(dir, ["status", "--porcelain"])
	if (status.stdout) {
		notes.push(`${dir} has uncommitted changes, so it was not updated from ${remoteName}/${branch}.`)
		return
	}
	const merged = await git(dir, ["merge", "--ff-only", "--quiet", `${remoteName}/${branch}`])
	if (!merged.ok) {
		notes.push(`${dir} has local commits that ${remoteName}/${branch} does not, so it was not updated.`)
	}
}

/** Removes a worktree the board created; refuses one with uncommitted changes. */
export async function removeWorktree(repoRoot: string, dir: string): Promise<void> {
	const status = await git(dir, ["status", "--porcelain"])
	if (status.stdout) {
		throw new Error(`${dir} has uncommitted changes; commit or discard them first.`)
	}
	await gitOrThrow(repoRoot, ["worktree", "remove", dir], `remove the worktree ${dir}`)
}

/** Whether `folder` is in a git working tree; false when git is missing or the folder does not exist. */
export async function isInGitRepository(folder: string): Promise<boolean> {
	const result = await git(folder, ["rev-parse", "--is-inside-work-tree"], 10_000)
	return result.ok && result.stdout === "true"
}

/** A new conversation worktree, plus what the user should know about it. */
interface EnsuredTaskWorktree extends TaskWorktree {
	/** E.g. that the checkout's uncommitted changes are not in the worktree. */
	notes: string[]
}

interface EnsureTaskWorktreeOptions {
	/** A folder in the repository; resolved to the top level of its checkout. */
	repoRoot: string
	/** The conversation's title or prompt; the branch is named after it. */
	title: string
	/**
	 * `plinycode.worktrees.root`, else `plinycode.ci.worktreeRoot`; empty puts
	 * worktrees next to the repository (see `worktreeRoot`).
	 */
	configuredRoot?: string
}

const TASK_BRANCH_PREFIX = "plinycode/"
const MAX_TASK_SLUG = 40
/** The folder name repeats the start of the slug only, so Windows paths stay short. */
const MAX_TASK_FOLDER_SLUG = 24

/** `Fix the login page!` → `fix-the-login-page`: lowercase ASCII words, at most 40 characters. */
export function taskBranchSlug(title: string): string {
	const slug = title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return trimSlug(slug, MAX_TASK_SLUG) || "task"
}

/** Cuts `slug` to `max` characters, at a word boundary when one is not too far back. */
function trimSlug(slug: string, max: number): string {
	if (slug.length <= max) {
		return slug
	}
	const cut = slug.slice(0, max)
	const dash = cut.lastIndexOf("-")
	return (dash >= max / 2 ? cut.slice(0, dash) : cut).replace(/-+$/, "")
}

/**
 * Creates a worktree for a new conversation: a fresh branch
 * `plinycode/<slug>-<4 hex>` from the checkout's current `HEAD` (nothing is
 * fetched), in a folder under `worktreeRoot`. Throws, with a message for the
 * user, when git is missing, the folder is not in a repository, the
 * repository has no commit yet, or the worktree cannot be set up.
 */
export async function ensureTaskWorktree(options: EnsureTaskWorktreeOptions): Promise<EnsuredTaskWorktree> {
	const top = await git(options.repoRoot, ["rev-parse", "--show-toplevel"])
	if (!top.ok || !top.stdout) {
		throw new Error(
			top.missing
				? "Git is not installed or not on PATH."
				: `${options.repoRoot} is not in a git repository${top.stderr ? ` (${top.stderr})` : ""}.`,
		)
	}
	const repoRoot = path.normalize(top.stdout)
	const head = await git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
	if (!head.ok || !head.stdout) {
		throw new Error(`${repoRoot} has no commit yet, so there is nothing to branch the worktree from.`)
	}
	// Started from a worktree, the new one still goes next to the main checkout.
	const mainCheckout = (await listWorktrees(repoRoot))[0]?.path ?? repoRoot
	const root = worktreeRoot(mainCheckout, options.configuredRoot)
	const slug = taskBranchSlug(options.title)
	const folderSlug = trimSlug(slug, MAX_TASK_FOLDER_SLUG)

	for (let attempt = 0; attempt < 5; attempt++) {
		const suffix = randomBytes(2).toString("hex")
		const branch = `${TASK_BRANCH_PREFIX}${slug}-${suffix}`
		const target = path.join(root, `${folderSlug}-${suffix}`)
		const taken = existsSync(target) || (await git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok
		if (taken) {
			continue
		}
		await gitOrThrow(repoRoot, ["worktree", "add", "-b", branch, target, head.stdout], `create a worktree in ${target}`)
		if (existsSync(path.join(target, ".gitmodules"))) {
			const submodules = await git(target, ["submodule", "update", "--init", "--recursive"], 600_000)
			if (!submodules.ok) {
				// Half a checkout would only confuse the agent; leave nothing behind.
				await git(repoRoot, ["worktree", "remove", "--force", target])
				await git(repoRoot, ["branch", "-D", branch])
				throw new Error(`Could not check out the submodules in ${target}: ${submodules.stderr || "git submodule failed"}`)
			}
		}
		const notes: string[] = []
		if ((await git(repoRoot, ["status", "--porcelain"])).stdout) {
			notes.push(
				`${repoRoot} has uncommitted changes. They are not in the worktree, which starts from the last commit (${head.stdout.slice(0, 8)}).`,
			)
		}
		return { repoRoot, branch, path: target, notes }
	}
	throw new Error(`Could not find a free branch name for a worktree under ${root}.`)
}
