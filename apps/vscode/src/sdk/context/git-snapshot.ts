// Gathers the git snapshot shown in the system prompt's <env> block: current
// and default branch, a short status and the latest commits. Runs when a
// conversation starts (see conversation-git-snapshots.ts), so it must be quick
// and must never hang: every git process shares one time limit, and whatever
// has arrived by then is what the snapshot holds.

import { spawn } from "node:child_process"
import type { GitSnapshot } from "@plinycode/shared"

/** Time limit for the whole snapshot, not per command. */
export const GIT_SNAPSHOT_TIMEOUT_MS = 2000
export const GIT_SNAPSHOT_MAX_STATUS_ENTRIES = 20
const MAX_COMMITS = 5
const MAX_STATUS_LINE_LENGTH = 200
const MAX_COMMIT_LINE_LENGTH = 120
const MAX_REF_NAME_LENGTH = 200
// `git status` in a tree with a huge number of changes; what is read past this is dropped.
const MAX_STDOUT_CHARS = 4 * 1024 * 1024
// How long a runner gets to hand back its partial output once the time limit hits.
const ABORT_GRACE_MS = 50

export interface GitRunResult {
	/** What the command printed before it ended or was stopped. */
	stdout: string
	/** Undefined when git could not be started or was stopped at the time limit. */
	exitCode?: number
	/** The command was stopped at the time limit; `stdout` holds what had arrived. */
	timedOut?: boolean
}

/** Runs `git <args>` in `cwd`. Resolves (never rejects) once the command ends or `signal` aborts. */
export type GitRunner = (args: readonly string[], options: { cwd: string; signal: AbortSignal }) => Promise<GitRunResult>

export const runGit: GitRunner = (args, { cwd, signal }) =>
	new Promise<GitRunResult>((resolve) => {
		if (signal.aborted) {
			resolve({ stdout: "", timedOut: true })
			return
		}

		let stdout = ""
		let settled = false
		let onAbort: (() => void) | undefined
		const finish = (result: GitRunResult) => {
			if (settled) {
				return
			}
			settled = true
			if (onAbort) {
				signal.removeEventListener("abort", onAbort)
			}
			resolve(result)
		}

		try {
			// Nothing here may wait on a person or on another git process: no
			// pager, no credential prompt, no stdin, and no index refresh lock
			// that a concurrent `git status` in the user's terminal would fight.
			const child = spawn("git", ["--no-pager", ...args], {
				cwd,
				env: {
					...process.env,
					GIT_OPTIONAL_LOCKS: "0",
					GIT_PAGER: "cat",
					PAGER: "cat",
					GIT_TERMINAL_PROMPT: "0",
				},
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			})
			onAbort = () => {
				child.kill()
				finish({ stdout, timedOut: true })
			}
			signal.addEventListener("abort", onAbort, { once: true })
			child.stdout.setEncoding("utf8")
			child.stdout.on("data", (chunk: string) => {
				if (stdout.length < MAX_STDOUT_CHARS) {
					stdout += chunk
				}
			})
			// git is not installed, or cwd no longer exists.
			child.on("error", () => finish({ stdout }))
			child.on("close", (code) => finish({ stdout, exitCode: code ?? undefined }))
		} catch {
			finish({ stdout })
		}
	})

// origin/HEAD names the default branch when the repository was cloned. Without
// it, a main or master branch is the conventional default.
const ORIGIN_HEAD_REF = "refs/remotes/origin/HEAD"
const ORIGIN_PREFIX = "refs/remotes/origin/"
const CONVENTIONAL_DEFAULT_REFS = [
	"refs/remotes/origin/main",
	"refs/remotes/origin/master",
	"refs/heads/main",
	"refs/heads/master",
]

function parseDefaultBranch(stdout: string): string | undefined {
	const refs = new Map<string, string>()
	for (const line of splitLines(stdout)) {
		const [refName, symref = ""] = line.split(" ")
		refs.set(refName, symref)
	}
	const originHead = refs.get(ORIGIN_HEAD_REF)
	if (originHead?.startsWith(ORIGIN_PREFIX)) {
		return originHead.slice(ORIGIN_PREFIX.length)
	}
	const conventional = CONVENTIONAL_DEFAULT_REFS.find((refName) => refs.has(refName))
	return conventional?.split("/").pop()
}

function splitLines(text: string): string[] {
	return text.split(/\r?\n/).filter((line) => line.trim().length > 0)
}

/**
 * Branch names, paths and commit subjects end up in the system prompt: keep
 * each on its own line and bounded.
 */
function cleanLine(line: string, maxLength: number): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being removed
	const cleaned = line.replace(/[\u0000-\u001f\u007f]/g, "").trimEnd()
	return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned
}

export interface GatherGitSnapshotOptions {
	runGit?: GitRunner
	timeoutMs?: number
}

/**
 * The git snapshot of `cwd`, or undefined when it is not inside a git
 * repository, git is not installed, or nothing came back within the time limit.
 */
export async function gatherGitSnapshot(cwd: string, options: GatherGitSnapshotOptions = {}): Promise<GitSnapshot | undefined> {
	const run = options.runGit ?? runGit
	const controller = new AbortController()
	const { signal } = controller
	// A runner returns its partial output when the signal aborts. Should one
	// not return at all, stop waiting for it shortly after.
	let graceTimer: ReturnType<typeof setTimeout> | undefined
	const gaveUp = new Promise<GitRunResult>((resolve) => {
		signal.addEventListener("abort", () => {
			graceTimer = setTimeout(() => resolve({ stdout: "", timedOut: true }), ABORT_GRACE_MS)
		})
	})
	const exec = (...args: string[]): Promise<GitRunResult> =>
		Promise.race([run(args, { cwd, signal }).catch((): GitRunResult => ({ stdout: "" })), gaveUp])
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? GIT_SNAPSHOT_TIMEOUT_MS)

	try {
		// In parallel: a slow `git status` in a big repository must not cost
		// the branch and the commits their share of the time limit.
		const [branchResult, refsResult, logResult, statusResult] = await Promise.all([
			// Exits 0 with the branch, 1 on a detached HEAD, 128 outside a repository.
			exec("symbolic-ref", "--short", "-q", "HEAD"),
			exec("for-each-ref", "--format=%(refname) %(symref)", ORIGIN_HEAD_REF, ...CONVENTIONAL_DEFAULT_REFS),
			exec("log", `-${MAX_COMMITS}`, "--format=%h %s"),
			exec("status", "--porcelain"),
		])

		const inRepository =
			branchResult.exitCode === 0 || branchResult.exitCode === 1 || logResult.exitCode === 0 || statusResult.exitCode === 0
		if (!inRepository) {
			return undefined
		}

		const snapshot: GitSnapshot = {}
		const branch = branchResult.exitCode === 0 ? cleanLine(branchResult.stdout.trim(), MAX_REF_NAME_LENGTH) : ""
		if (branch) {
			snapshot.branch = branch
		}

		const commits =
			logResult.exitCode === 0
				? splitLines(logResult.stdout)
						.slice(0, MAX_COMMITS)
						.map((line) => cleanLine(line, MAX_COMMIT_LINE_LENGTH))
				: []
		if (commits.length > 0) {
			snapshot.recentCommits = commits
			// Only a detached HEAD is described by its commit; a branch lookup
			// that merely timed out must not read as one.
			if (branchResult.exitCode === 1) {
				snapshot.head = commits[0].split(" ")[0]
			}
		}

		const defaultBranch = refsResult.exitCode === 0 ? parseDefaultBranch(refsResult.stdout) : undefined
		if (defaultBranch) {
			snapshot.defaultBranch = cleanLine(defaultBranch, MAX_REF_NAME_LENGTH)
		}

		if (statusResult.exitCode === 0 || statusResult.timedOut) {
			let stdout = statusResult.stdout
			if (statusResult.timedOut) {
				// The last line may have been cut mid-path.
				stdout = stdout.slice(0, stdout.lastIndexOf("\n") + 1)
				snapshot.statusIncomplete = true
			}
			const entries = splitLines(stdout)
			if (entries.length > 0 || !statusResult.timedOut) {
				snapshot.status = entries
					.slice(0, GIT_SNAPSHOT_MAX_STATUS_ENTRIES)
					.map((line) => cleanLine(line, MAX_STATUS_LINE_LENGTH))
			}
			if (entries.length > GIT_SNAPSHOT_MAX_STATUS_ENTRIES) {
				snapshot.statusOmitted = entries.length - GIT_SNAPSHOT_MAX_STATUS_ENTRIES
			}
		}

		return snapshot
	} finally {
		clearTimeout(timer)
		// Stops any command still running; a no-op after the time limit.
		controller.abort()
		clearTimeout(graceTimer)
	}
}
