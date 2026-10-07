/** Turns runs into the board's per-pipeline dots, and successive snapshots into transitions. */
import type { PipelineRun } from "../server/providers/types"
import type { CiBoardItem, CiColor, CiPipelineStatus, CiTransition } from "./types"

export function colorOf(run: Pick<PipelineRun, "status" | "result"> | undefined): CiColor {
	if (!run) {
		return "grey"
	}
	if (run.status !== "completed") {
		return "yellow"
	}
	if (run.result === "success") {
		return "green"
	}
	if (run.result === "failure" || run.result === "partial") {
		return "red"
	}
	return "grey"
}

const pipelineName = (run: PipelineRun): string => run.pipeline ?? run.name

/**
 * One status per pipeline for the runs of one commit: the newest run of each
 * wins, so a re-run replaces the failure it retried. Pipelines in `known` that
 * have no run on this commit show grey: Azure DevOps, for one, never queues a
 * conflicted PR's build.
 */
export function groupPipelines(runs: PipelineRun[], known: Iterable<string> = []): CiPipelineStatus[] {
	const newest = new Map<string, PipelineRun>()
	for (const run of runs) {
		const name = pipelineName(run)
		const current = newest.get(name)
		if (!current || run.id > current.id) {
			newest.set(name, run)
		}
	}
	const statuses = new Map<string, CiPipelineStatus>()
	for (const name of known) {
		statuses.set(name, { name, color: "grey" })
	}
	for (const [name, run] of newest) {
		statuses.set(name, {
			name,
			color: colorOf(run),
			status: run.status,
			result: run.result,
			runId: run.id,
			url: run.url,
		})
	}
	return [...statuses.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const reds = (item: CiBoardItem | undefined) => new Set(item?.pipelines.filter((p) => p.color === "red").map((p) => p.name) ?? [])

/**
 * What changed between two snapshots of an item. The first snapshot (no
 * `prev`) yields nothing, so opening the board does not notify about what was
 * already red. A pipeline that stays red on the same commit is not reported
 * again; on a new commit, a red pipeline is a new failure.
 */
export function diffItems(targetId: string, prev: CiBoardItem | undefined, next: CiBoardItem): CiTransition[] {
	if (!prev) {
		return []
	}
	const transitions: CiTransition[] = []
	const sameHead = prev.headSha === next.headSha
	const before = sameHead ? reds(prev) : new Set<string>()
	const failed = [...reds(next)].filter((name) => !before.has(name))
	const base = { targetId, itemKey: next.key, headSha: next.headSha }
	if (failed.length > 0) {
		transitions.push({ ...base, kind: "failed", pipelines: failed })
	}
	if (next.mergeState === "conflicts" && (prev.mergeState !== "conflicts" || !sameHead)) {
		transitions.push({ ...base, kind: "conflict", pipelines: [] })
	}
	const allGreen =
		next.pipelines.some((p) => p.color === "green") && next.pipelines.every((p) => p.color === "green" || p.color === "grey")
	if (allGreen && reds(prev).size > 0) {
		transitions.push({ ...base, kind: "recovered", pipelines: [] })
	}
	return transitions
}
