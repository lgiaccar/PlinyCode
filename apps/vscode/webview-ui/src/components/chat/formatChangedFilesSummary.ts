export interface ChangedFilesSummaryCounts {
	fileCount: number
	totalAdded: number
	totalRemoved: number
}

/**
 * User-visible summary for the completion-card changed-files row.
 * Example: "10 files edited, +300 / -45 lines"
 */
export function formatChangedFilesSummaryLine({ fileCount, totalAdded, totalRemoved }: ChangedFilesSummaryCounts): string {
	const fileLabel = fileCount === 1 ? "1 file edited" : `${fileCount} files edited`
	return `${fileLabel}, +${totalAdded} / -${totalRemoved} lines`
}

/** Total changed lines (additions + deletions) for optional compact display. */
export function formatChangedFilesTotalLineCount(totalAdded: number, totalRemoved: number): number {
	return totalAdded + totalRemoved
}
