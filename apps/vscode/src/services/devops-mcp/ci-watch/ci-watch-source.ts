/** Resolves what a `watch_ci` call should watch, and reads it through the provider code the DevOps tools use. */
import { adoAuth, type EditorTokenSource, githubAuth } from "../server/auth"
import { DevOpsError } from "../server/errors"
import { AzureDevOpsProvider } from "../server/providers/azdo"
import { GitHubProvider } from "../server/providers/github"
import type { PipelineRun, Provider, PullRequest } from "../server/providers/types"
import { loadContext, pushProblem, type RepoContext, remoteBranchHead, remoteKey } from "../server/repo"
import type { CiWatchSource } from "./ci-watcher"

/** Runs listed per poll; the ones for the watched commit are picked out of these. */
const RUN_LIMIT = 50
/** Log lines per failed step, as `pipeline_report` reads by default. */
const LOG_LINES = 40

export interface CiWatchRepo {
	ctx: RepoContext
	provider: Provider
}

export type CiWatchRepoOpener = (cwd: string) => Promise<CiWatchRepo>

/**
 * Opens repositories for the watcher with providers that live in the extension
 * host. They sign in like the server does, except that they never show a
 * sign-in prompt: a background poll must not pop one up.
 */
export function createCiWatchRepoOpener(
	silentEditorToken: (provider: "github" | "ado", host: string) => Promise<string | undefined>,
): CiWatchRepoOpener {
	const providers = new Map<string, Provider>()
	const editorToken: EditorTokenSource = (provider, host, interactive) =>
		interactive ? Promise.resolve(undefined) : silentEditorToken(provider, host)
	return async (cwd) => {
		const ctx = await loadContext(cwd)
		const key = remoteKey(ctx.remote)
		let provider = providers.get(key)
		if (!provider) {
			provider =
				ctx.remote.kind === "github"
					? new GitHubProvider(ctx.remote, undefined, githubAuth(ctx.remote.host, editorToken))
					: new AzureDevOpsProvider(ctx.remote, undefined, adoAuth(editorToken))
			providers.set(key, provider)
		}
		return { ctx, provider }
	}
}

interface CiWatchTarget {
	/** How the target is named in messages: "PR #12 (feature → main)" or "branch feature". */
	label: string
	pr?: PullRequest
	branch: string
	/** The head commit when the watch was registered. */
	head: string
	/** Things the model should hear at registration, e.g. commits that are not pushed. */
	warnings: string[]
}

/**
 * The pull request named by `pr`, else the open pull request of `branch` (the
 * current branch by default), else that branch's pushed head commit.
 */
export async function resolveCiWatchTarget(repo: CiWatchRepo, input: { pr?: number; branch?: string }): Promise<CiWatchTarget> {
	const { ctx, provider } = repo
	let pr: PullRequest | undefined
	let branch: string
	if (input.pr !== undefined) {
		pr = await provider.getPr(input.pr)
		branch = pr.sourceBranch
	} else {
		const named = input.branch || ctx.branch
		if (!named) {
			throw new DevOpsError("HEAD is detached, so there is no current branch; pass `pr` or `branch`.")
		}
		branch = named
		pr = await provider.findOpenPr(branch)
	}
	// Only the checked-out branch can have local commits that CI will never see.
	const unpushed = ctx.branch === branch ? await pushProblem(ctx, branch) : undefined
	if (pr) {
		if (!pr.headSha) {
			throw new DevOpsError(`${provider.kind} did not report the head commit of PR #${pr.id}; pass \`branch\` instead.`)
		}
		return {
			label: `PR #${pr.id} (${pr.sourceBranch} → ${pr.targetBranch})`,
			pr,
			branch,
			head: pr.headSha,
			warnings: unpushed ? [unpushed] : [],
		}
	}
	const head = await remoteBranchHead(ctx, branch)
	if (!head) {
		throw new DevOpsError(
			`Branch '${branch}' has not been pushed, so there is no CI to watch. Run \`git push -u ${ctx.remoteName} ${branch}\` first.`,
		)
	}
	return { label: `branch ${branch}`, branch, head, warnings: unpushed ? [unpushed] : [] }
}

export function createCiWatchSource(repo: CiWatchRepo, target: CiWatchTarget): CiWatchSource {
	const { ctx, provider } = repo
	const { pr, branch } = target
	let lastHead = target.head
	return {
		head: async () => {
			// A pull request's head comes from the provider. A bare branch has no
			// such record, so its head is the remote-tracking ref, which a push
			// from this checkout updates.
			const head = pr ? (await provider.getPr(pr.id)).headSha : await remoteBranchHead(ctx, branch)
			lastHead = head ?? lastHead
			return lastHead
		},
		runs: async (head) => {
			// Azure DevOps builds a pull request on its merge ref and the branch on
			// its own ref, so a pull request's runs are in both lists.
			const lists = pr
				? await Promise.all([
						provider.listRuns(undefined, { ...pr, headSha: head }, RUN_LIMIT),
						provider.listRuns(branch, undefined, RUN_LIMIT),
					])
				: [await provider.listRuns(branch, undefined, RUN_LIMIT)]
			const runs = new Map<number, PipelineRun>()
			for (const run of lists.flat()) {
				if ((run.headCommit ?? run.commit) === head) {
					runs.set(run.id, run)
				}
			}
			return [...runs.values()]
		},
		report: (runId) => provider.runReport(runId, LOG_LINES),
	}
}
