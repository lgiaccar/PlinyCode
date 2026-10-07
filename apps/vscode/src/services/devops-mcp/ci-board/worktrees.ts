/**
 * Git worktrees for CI board runs: each pull request's branch gets its own
 * working copy next to the repository, so several branches can be fixed at
 * once without touching the user's checkout.
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"
import { DevOpsError } from "../server/errors"

interface GitResult {
	ok: boolean
	stdout: string
	stderr: string
}

function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", cwd, ...args],
			{ windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs },
			(error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout).trim(), stderr: String(stderr).trim() }),
		)
	})
}

async function gitOrThrow(cwd: string, args: string[], what: string): Promise<string> {
	const result = await git(cwd, args)
	if (!result.ok) {
		throw new DevOpsError(`Could not ${what}: ${result.stderr || `git ${args.join(" ")} failed`}`)
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
		throw new DevOpsError(`Could not fetch '${branch}' from ${remoteName}: ${fetched.stderr || "git fetch failed"}`)
	}

	const existing = (await listWorktrees(repoRoot)).find((w) => w.branch === branch)
	if (existing) {
		await fastForward(existing.path, remoteName, branch, notes)
		return { path: existing.path, inPlace: false, created: false, notes }
	}

	const target = path.join(options.root, worktreeSlug(branch))
	if (existsSync(target)) {
		throw new DevOpsError(
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
		throw new DevOpsError(`${dir} has uncommitted changes; commit or discard them first.`)
	}
	await gitOrThrow(repoRoot, ["worktree", "remove", dir], `remove the worktree ${dir}`)
}
