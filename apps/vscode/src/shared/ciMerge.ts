/** The same conservative merge gate is used by the board UI and the fresh server-side check. */
export function ciMergeDisabledReason(item: {
	prId: number
	state: string
	draft: boolean
	headSha?: string
	mergeState?: string
	error?: string
	pipelines: readonly { color: string }[]
	expiredBuildPolicies?: readonly unknown[]
	buildPolicies?: readonly { expired: boolean; status: string }[]
}): string | undefined {
	if (!item.prId || item.state !== "open") return "Only an open pull request can be merged."
	if (item.draft) return "Mark this pull request ready for review before merging."
	if (item.error) return "Refresh the board to resolve the CI status error before merging."
	if (!item.headSha) return "Refresh the board to identify the pull request's head commit."
	if (item.mergeState !== "clean") return "Wait for a clean merge check and resolve any conflicts before merging."
	if (item.pipelines.length === 0 || item.pipelines.some((pipeline) => pipeline.color !== "green")) {
		return "All pipelines must be green on the current commit before merging."
	}
	if (
		item.expiredBuildPolicies?.length ||
		item.buildPolicies?.some((policy) => policy.expired || policy.status !== "approved")
	) {
		return "All build validations must be current and approved before merging."
	}
	return undefined
}
