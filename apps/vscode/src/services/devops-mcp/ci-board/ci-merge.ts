import { ciMergeDisabledReason } from "@shared/ciMerge"
import { runsForHead } from "../ci-watch/ci-watch-source"
import { DevOpsError } from "../server/errors"
import type { Provider } from "../server/providers/types"
import { groupPipelines } from "./ci-board-snapshot"
import type { CiBoardItem } from "./types"

/** Validate fresh CI and pin the merge to the PR version the user actually selected. */
export async function mergeGreenCiPr(provider: Provider, item: CiBoardItem, expectedHead: string, expectedTarget: string) {
	if (
		!item.pr ||
		!expectedHead ||
		!expectedTarget ||
		item.headSha !== expectedHead ||
		item.pr.targetBranch !== expectedTarget
	) {
		throw new DevOpsError("That pull request changed; refresh the board before merging.")
	}
	if (!provider.mergePr) throw new DevOpsError("This provider cannot merge pull requests from the board.")
	const pr = await provider.getPr(item.pr.id)
	if (pr.headSha !== expectedHead || pr.targetBranch !== expectedTarget) {
		throw new DevOpsError("The pull request's head or target branch changed; refresh the board before merging.")
	}
	if (pr.state !== "open" || pr.draft || pr.mergeState !== "clean") {
		throw new DevOpsError("The pull request must be open, ready for review, and merge cleanly.")
	}
	const [runs, checks, policies, expired] = await Promise.all([
		runsForHead(provider, pr, pr.sourceBranch, expectedHead, 100, true),
		provider.prChecks(pr),
		provider.listBuildPolicies?.(pr),
		provider.listBuildPolicies ? undefined : provider.listExpiredBuildPolicies?.(pr),
	])
	const reason = ciMergeDisabledReason({
		prId: pr.id,
		state: pr.state,
		draft: pr.draft,
		headSha: pr.headSha,
		mergeState: pr.mergeState,
		pipelines: groupPipelines(
			runs,
			item.pipelines.map((pipeline) => pipeline.name),
		),
		buildPolicies: policies,
		expiredBuildPolicies: expired,
	})
	if (reason) throw new DevOpsError(reason)
	const blocked = checks.find(
		(check) =>
			check.status !== "completed" || (check.result !== "success" && !(check.result === "skipped" && !check.required)),
	)
	if (blocked) throw new DevOpsError(`The check "${blocked.name}" has not passed; refresh the board before merging.`)
	// Recheck after reading CI: pushes, retargeting and draft/closed transitions must not slip through.
	const latest = await provider.getPr(pr.id)
	if (
		latest.headSha !== expectedHead ||
		latest.targetBranch !== expectedTarget ||
		latest.state !== "open" ||
		latest.draft ||
		latest.mergeState !== "clean"
	) {
		throw new DevOpsError("The pull request changed while checking CI; refresh the board before merging.")
	}
	await provider.mergePr(pr.id, expectedHead)
}
