import path from "node:path"
import type { CheckpointContentDiff } from "@plinycode/core"
import { countCheckpointLineChanges, getCheckpointFileChangeStatus } from "./checkpoint-line-diff"

export interface BuiltChangedFileSummary {
	filePath: string
	relativePath: string
	addedLines: number
	removedLines: number
	status: string
}

export function buildChangedFileSummaries(diffs: CheckpointContentDiff[], cwd: string): BuiltChangedFileSummary[] {
	return diffs
		.map((diff) => {
			const { added, removed } = countCheckpointLineChanges(diff.leftContent, diff.rightContent)
			const relativePath = (path.relative(cwd, diff.filePath) || path.basename(diff.filePath)).replace(/\\/g, "/")
			return {
				filePath: diff.filePath,
				relativePath,
				addedLines: added,
				removedLines: removed,
				status: getCheckpointFileChangeStatus(diff.leftContent, diff.rightContent),
			}
		})
		.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}
