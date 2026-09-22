import { diffLines } from "diff"

export type CheckpointFileChangeStatus = "added" | "modified" | "deleted"

export interface CheckpointLineChangeCounts {
	added: number
	removed: number
}

/** Normalize line endings before diffing so CRLF vs LF does not skew counts. */
export function normalizeContentLineEndings(content: string): string {
	return content.replace(/\r\n/g, "\n")
}

export function getCheckpointFileChangeStatus(leftContent: string, rightContent: string): CheckpointFileChangeStatus {
	if (leftContent.length === 0) {
		return "added"
	}
	if (rightContent.length === 0) {
		return "deleted"
	}
	return "modified"
}

/**
 * Count added/removed lines between checkpoint left and working-tree right content.
 * Uses the same line-diff semantics as the `diff` package (including trailing-newline handling).
 */
export function countCheckpointLineChanges(leftContent: string, rightContent: string): CheckpointLineChangeCounts {
	const left = normalizeContentLineEndings(leftContent)
	const right = normalizeContentLineEndings(rightContent)
	let added = 0
	let removed = 0
	for (const part of diffLines(left, right)) {
		const count = part.count ?? 0
		if (part.added) {
			added += count
		} else if (part.removed) {
			removed += count
		}
	}
	return { added, removed }
}
