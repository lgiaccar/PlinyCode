/**
 * Bringing a "Run in worktree" conversation's work back (docs/task-worktrees.md):
 * applying its changes to the checkout it was branched from, committing and
 * pushing them for a pull request, and removing the worktree afterwards.
 */
import { randomBytes } from "node:crypto"
import { existsSync, promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { TaskWorktree } from "@shared/HistoryItem"
import { git } from "./worktrees"

/** A refusal with a message for the user; nothing was changed. */
export class WorktreeActionError extends Error {}

/** Paths with uncommitted changes in `dir`, untracked files included; renames list both paths. */
export async function changedPaths(dir: string): Promise<string[]> {
	const status = await git(dir, ["status", "--porcelain", "-z", "--untracked-files=all"], 120_000, { raw: true })
	if (!status.ok) {
		throw new WorktreeActionError(`Could not read the git status of ${dir}: ${status.stderr || "git status failed"}`)
	}
	const paths: string[] = []
	const entries = status.stdout.split("\0")
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]
		if (entry.length < 4) {
			continue
		}
		paths.push(entry.slice(3))
		// A rename or copy is followed by its original path.
		if (entry[0] === "R" || entry[0] === "C") {
			const original = entries[++i]
			if (original) paths.push(original)
		}
	}
	return paths
}

/**
 * The commit the worktree's changes are measured from: the recorded base when
 * it is still there, else the merge base of the worktree's `HEAD` and the
 * source checkout's.
 */
export async function worktreeBase(worktree: TaskWorktree): Promise<string> {
	if (worktree.baseCommit) {
		const recorded = await git(worktree.path, ["rev-parse", "--verify", "--quiet", `${worktree.baseCommit}^{commit}`])
		if (recorded.ok && recorded.stdout) {
			return recorded.stdout
		}
	}
	const sourceHead = await git(worktree.repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
	const base = sourceHead.ok ? await git(worktree.path, ["merge-base", "HEAD", sourceHead.stdout]) : undefined
	if (!base?.ok || !base.stdout) {
		throw new WorktreeActionError(
			`Could not find the commit ${worktree.branch} was branched from in ${worktree.repoRoot}${base?.stderr ? ` (${base.stderr})` : ""}.`,
		)
	}
	return base.stdout
}

/**
 * Writes the worktree's changes since `base` (its commits, staged and unstaged
 * edits and new files that are not ignored) to `patchFile` as one binary patch,
 * and returns the paths it touches. The worktree's own index is not touched:
 * the snapshot is staged in a temporary index.
 */
async function writeWorktreePatch(dir: string, base: string, patchFile: string): Promise<string[]> {
	const index = path.join(os.tmpdir(), `plinycode-worktree-${randomBytes(4).toString("hex")}.index`)
	const env = { GIT_INDEX_FILE: index }
	try {
		for (const args of [
			["read-tree", "HEAD"],
			["add", "-A"],
		]) {
			const result = await git(dir, args, 300_000, { env })
			if (!result.ok) {
				throw new WorktreeActionError(
					`Could not read the worktree's changes: ${result.stderr || `git ${args[0]} failed`}`,
				)
			}
		}
		const names = await git(dir, ["diff", "--cached", "--no-renames", "--name-only", "-z", base], 300_000, { env, raw: true })
		if (!names.ok) {
			throw new WorktreeActionError(`Could not list the worktree's changes: ${names.stderr || "git diff failed"}`)
		}
		const files = names.stdout.split("\0").filter(Boolean)
		if (files.length > 0) {
			const diff = await git(
				dir,
				["diff", "--cached", "--no-renames", "--binary", "--full-index", `--output=${patchFile}`, base],
				300_000,
				{ env },
			)
			if (!diff.ok) {
				throw new WorktreeActionError(
					`Could not write the worktree's changes as a patch: ${diff.stderr || "git diff failed"}`,
				)
			}
		}
		return files
	} finally {
		await fs.rm(index, { force: true }).catch(() => undefined)
		await fs.rm(`${index}.lock`, { force: true }).catch(() => undefined)
	}
}

interface AppliedWorktree {
	/** The paths now staged in the source checkout. */
	files: string[]
	base: string
}

/**
 * "Apply": brings the worktree's changes since its base into the source
 * checkout (`worktree.repoRoot`) with `git apply --3way --index`, and leaves
 * them staged there, uncommitted. Refuses, changing nothing, when the checkout
 * has uncommitted changes to the same paths, or when the patch would not apply
 * cleanly (checked with `git apply --check` first).
 */
export async function applyWorktreeToSource(worktree: TaskWorktree): Promise<AppliedWorktree> {
	if (!existsSync(worktree.path)) {
		throw new WorktreeActionError(`The worktree ${worktree.path} no longer exists.`)
	}
	if (!existsSync(worktree.repoRoot)) {
		throw new WorktreeActionError(`The checkout ${worktree.repoRoot} no longer exists.`)
	}
	const base = await worktreeBase(worktree)
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "plinycode-apply-"))
	try {
		const patchFile = path.join(scratch, "worktree.patch")
		const files = await writeWorktreePatch(worktree.path, base, patchFile)
		if (files.length === 0) {
			throw new WorktreeActionError(`The worktree has no changes since ${base.slice(0, 8)}, so there is nothing to apply.`)
		}
		const local = new Set(await changedPaths(worktree.repoRoot))
		const overlap = files.filter((file) => local.has(file))
		if (overlap.length > 0) {
			throw new WorktreeActionError(
				`${worktree.repoRoot} has uncommitted changes to ${listPaths(overlap)}, which the worktree changes too. Commit, stash or discard them there first.`,
			)
		}
		const check = await git(worktree.repoRoot, ["apply", "--check", "--3way", "--index", patchFile], 300_000)
		// With --3way, --check succeeds even when a file would get conflict markers; it only says so.
		const conflicted = [...`${check.stderr}\n${check.stdout}`.matchAll(/Applied patch to '(.+?)' with conflicts/g)].map(
			(match) => match[1],
		)
		if (!check.ok || conflicted.length > 0) {
			throw new WorktreeActionError(
				conflicted.length > 0
					? `The worktree's changes conflict with ${worktree.repoRoot} in ${listPaths(conflicted)}. Nothing was applied; merge the branch ${worktree.branch} yourself instead.`
					: `The worktree's changes do not apply to ${worktree.repoRoot}, so nothing was applied: ${check.stderr || "git apply --check failed"}`,
			)
		}
		const applied = await git(worktree.repoRoot, ["apply", "--3way", "--index", patchFile], 300_000)
		if (!applied.ok) {
			throw new WorktreeActionError(
				`git apply failed in ${worktree.repoRoot} after its check passed: ${applied.stderr || "unknown error"}. Check \`git status\` there.`,
			)
		}
		return { files, base }
	} finally {
		await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined)
	}
}

function listPaths(paths: string[], max = 5): string {
	const shown = paths.slice(0, max).join(", ")
	return paths.length > max ? `${shown} and ${paths.length - max} more` : shown
}

/** Commits everything in `dir` (`git add -A`); false when there was nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
	if ((await changedPaths(dir)).length === 0) {
		return false
	}
	const added = await git(dir, ["add", "-A"], 300_000)
	if (!added.ok) {
		throw new WorktreeActionError(`Could not stage the worktree's changes: ${added.stderr || "git add failed"}`)
	}
	const committed = await git(dir, ["commit", "--quiet", "-m", message], 300_000)
	if (!committed.ok) {
		throw new WorktreeActionError(
			`Could not commit the worktree's changes: ${committed.stderr || committed.stdout || "git commit failed"}`,
		)
	}
	return true
}

/** One line per commit on `HEAD` since `base`, oldest first. */
export async function commitSubjects(dir: string, base: string): Promise<string[]> {
	const log = await git(dir, ["log", "--reverse", "--format=%s", `${base}..HEAD`])
	return log.ok ? log.stdout.split(/\r?\n/).filter(Boolean) : []
}

/** Pushes `branch` from `dir` to `remote` and sets it as the upstream. */
export async function pushBranch(dir: string, remote: string, branch: string): Promise<void> {
	const pushed = await git(dir, ["push", "--quiet", "-u", remote, `refs/heads/${branch}:refs/heads/${branch}`], 600_000)
	if (!pushed.ok) {
		throw new WorktreeActionError(`Could not push ${branch} to ${remote}: ${pushed.stderr || "git push failed"}`)
	}
}

/** The branch checked out in `dir`; undefined when `HEAD` is detached. */
export async function currentBranch(dir: string): Promise<string | undefined> {
	const result = await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"])
	return result.ok && result.stdout ? result.stdout : undefined
}

interface BranchMergeState {
	/** The branch's tip is in the history of the checkout's `HEAD`. */
	merged: boolean
	/** Commits on the branch that `HEAD` does not have. */
	unmerged: number
	/** What `HEAD` is, for messages: its branch, or "HEAD" when detached. */
	into: string
	/** The branch no longer exists. */
	missing?: boolean
}

/** Whether `branch` is merged into the `HEAD` of the checkout at `repoRoot`. */
export async function branchMergeState(repoRoot: string, branch: string): Promise<BranchMergeState> {
	const into = (await currentBranch(repoRoot)) ?? "HEAD"
	const ref = `refs/heads/${branch}`
	if (!(await git(repoRoot, ["rev-parse", "--verify", "--quiet", ref])).ok) {
		return { merged: true, unmerged: 0, into, missing: true }
	}
	const merged = (await git(repoRoot, ["merge-base", "--is-ancestor", ref, "HEAD"])).ok
	const count = await git(repoRoot, ["rev-list", "--count", `HEAD..${ref}`])
	return { merged, unmerged: merged ? 0 : Number.parseInt(count.stdout, 10) || 0, into }
}

interface RemoveTaskWorktreeOptions {
	/** Remove it even with uncommitted changes, which are lost. */
	force?: boolean
	deleteBranch?: boolean
}

/**
 * Removes a conversation's worktree (`git worktree remove`), and its branch
 * when asked. Refuses a worktree with uncommitted changes unless `force`. A
 * folder that is already gone is pruned from git's list instead.
 */
export async function removeTaskWorktree(
	worktree: TaskWorktree,
	options: RemoveTaskWorktreeOptions = {},
): Promise<{ branchDeleted: boolean }> {
	if (existsSync(worktree.path)) {
		if (!options.force) {
			const dirty = await changedPaths(worktree.path)
			if (dirty.length > 0) {
				throw new WorktreeActionError(
					`The worktree ${worktree.path} has uncommitted changes (${listPaths(dirty)}); commit or discard them first.`,
				)
			}
		}
		const args = ["worktree", "remove", ...(options.force ? ["--force"] : []), worktree.path]
		const removed = await git(worktree.repoRoot, args, 300_000)
		if (!removed.ok) {
			throw new WorktreeActionError(
				`Could not remove the worktree ${worktree.path}: ${removed.stderr || "git worktree remove failed"}`,
			)
		}
	} else {
		await git(worktree.repoRoot, ["worktree", "prune"])
	}
	if (!options.deleteBranch) {
		return { branchDeleted: false }
	}
	const deleted = await git(worktree.repoRoot, ["branch", "-D", worktree.branch])
	return { branchDeleted: deleted.ok }
}
