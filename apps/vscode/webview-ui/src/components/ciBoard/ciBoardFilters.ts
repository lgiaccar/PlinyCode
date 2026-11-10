import { ciMergeDisabledReason } from "@shared/ciMerge"
import type { CiItem, CiTargetView } from "@shared/proto/cline/ci_board"
import { isFailing } from "./ciBoardUtils"

export const CI_FILTERS = [
	{ id: "all", label: "All" },
	{ id: "attention", label: "Needs attention" },
	{ id: "failed", label: "Failed" },
	{ id: "conflicts", label: "Conflicts" },
	{ id: "expired", label: "Expired" },
	{ id: "running", label: "Running" },
	{ id: "ready", label: "CI ready" },
] as const

export type CiBoardFilter = (typeof CI_FILTERS)[number]["id"]

export function ciBoardMergeDisabledReason(item: CiItem, busy = false): string | undefined {
	if (busy || item.conversationStatus === "running" || item.conversationStatus === "background") {
		return "Wait for the board's running conversation to finish before merging."
	}
	return ciMergeDisabledReason(item)
}

export function matchesCiStatus(item: CiItem, filter: CiBoardFilter, targetError = ""): boolean {
	switch (filter) {
		case "all":
			return true
		case "attention":
			return (
				!!targetError ||
				!!item.error ||
				isFailing(item) ||
				item.buildPolicies.some((policy) => policy.expired || policy.status === "rejected") ||
				item.auto?.status === "needs_you"
			)
		case "failed":
			return item.pipelines.some((pipeline) => pipeline.color === "red")
		case "conflicts":
			return item.mergeState === "conflicts"
		case "expired":
			return item.expiredBuildPolicies.length > 0 || item.buildPolicies.some((policy) => policy.expired)
		case "running":
			return (
				item.pipelines.some((pipeline) => pipeline.color === "yellow") ||
				item.buildPolicies.some((policy) => policy.status === "queued" || policy.status === "running")
			)
		case "ready":
			return !targetError && ciBoardMergeDisabledReason(item) === undefined
	}
}

export function matchesCiSearch(item: CiItem, target: CiTargetView, query: string): boolean {
	const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
	const text = [
		target.label,
		target.remoteUrl,
		target.provider,
		item.title,
		item.prId ? `#${item.prId}` : "",
		item.sourceBranch,
		item.targetBranch,
		item.author,
		item.headSha,
		...item.pipelines.map((pipeline) => pipeline.name),
	]
		.join(" ")
		.toLocaleLowerCase()
	return words.every((word) => text.includes(word))
}

export function filteredCiItems(target: CiTargetView, filter: CiBoardFilter, query: string): CiItem[] {
	return target.items.filter((item) => matchesCiSearch(item, target, query) && matchesCiStatus(item, filter, target.error))
}
