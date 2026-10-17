import type { SessionHistoryRecord } from "@plinycode/core"
import { arePathsEqual } from "@/utils/path"
import {
	dateStringToTimestamp,
	metadataBoolean,
	metadataNumber,
	metadataString,
	metadataWorktree,
	sessionRecordWorkspacePath,
} from "./sdk-task-history"
import { readTaskUsageTotals } from "./task-usage-metadata"

/** The filters and sort order of the history view (the getTaskHistory RPC). */
export interface TaskHistoryQuery {
	favoritesOnly?: boolean
	/**
	 * Every whitespace-separated term must appear in the title, the workspace
	 * path or the worktree branch, in any case. queryTaskHistoryWithContent adds
	 * the conversations whose messages match it.
	 */
	searchQuery?: string
	/** "newest" (the default), "oldest", "mostExpensive" or "mostTokens". */
	sortBy?: string
	/** Only conversations bound to this workspace, or started from it in a worktree of their own. */
	workspacePath?: string
	/** Only conversations last active at or after this time (ms since epoch). 0 or absent = no lower bound. */
	fromTs?: number
	/** Only conversations started at or before this time (ms since epoch). 0 or absent = no upper bound. */
	toTs?: number
}

/** What the filters look at in one conversation. */
interface TaskHistoryRow {
	title: string
	workspacePath: string
	/** A worktree conversation: the workspace it was started from, which lists it too. */
	sourceWorkspacePath?: string
	/** A worktree conversation: its branch, which search looks at. */
	worktreeBranch?: string
	lastActiveTs: number
	startedTs: number
	isFavorited: boolean
}

export function sessionRecordLastActiveTs(record: SessionHistoryRecord): number {
	return dateStringToTimestamp(record.updatedAt ?? record.endedAt ?? record.startedAt)
}

export function sessionRecordTitle(record: SessionHistoryRecord): string {
	return metadataString(record.metadata, "title") ?? record.prompt ?? ""
}

export function isSessionRecordFavorited(record: SessionHistoryRecord): boolean {
	return metadataBoolean(record.metadata, "isFavorited") ?? metadataBoolean(record.metadata, "is_favorited") ?? false
}

export function isSessionRecordPinned(record: SessionHistoryRecord): boolean {
	return metadataBoolean(record.metadata, "isPinned") === true
}

function sessionRecordToRow(record: SessionHistoryRecord): TaskHistoryRow {
	const lastActiveTs = sessionRecordLastActiveTs(record)
	const worktree = metadataWorktree(record.metadata)
	return {
		title: sessionRecordTitle(record),
		workspacePath: sessionRecordWorkspacePath(record),
		sourceWorkspacePath: worktree?.sourceWorkspacePath,
		worktreeBranch: worktree?.branch,
		lastActiveTs,
		startedTs: metadataNumber(record.metadata, "startedTs") || dateStringToTimestamp(record.startedAt) || lastActiveTs,
		isFavorited: isSessionRecordFavorited(record),
	}
}

export function taskHistoryRowMatches(row: TaskHistoryRow, query: TaskHistoryQuery): boolean {
	if (!row.lastActiveTs || !row.title) {
		return false
	}
	if (query.favoritesOnly && !row.isFavorited) {
		return false
	}
	if (query.workspacePath && !rowInWorkspace(row, query.workspacePath)) {
		return false
	}
	// A conversation spans from its start to its last activity; it is in the
	// period when the two overlap.
	if (query.fromTs && row.lastActiveTs < query.fromTs) {
		return false
	}
	if (query.toTs && row.startedTs > query.toTs) {
		return false
	}
	const terms = (query.searchQuery ?? "").toLowerCase().split(/\s+/).filter(Boolean)
	if (terms.length > 0) {
		const haystack = `${row.title}\n${row.workspacePath}\n${row.worktreeBranch ?? ""}`.toLowerCase()
		if (!terms.every((term) => haystack.includes(term))) {
			return false
		}
	}
	return true
}

function rowInWorkspace(row: TaskHistoryRow, workspacePath: string): boolean {
	return [row.workspacePath, row.sourceWorkspacePath].some(
		(candidate) => !!candidate && arePathsEqual(candidate, workspacePath),
	)
}

function totalTokens(record: SessionHistoryRecord): number {
	const usage = readTaskUsageTotals(record.metadata)
	return usage.tokensIn + usage.tokensOut + usage.cacheWrites + usage.cacheReads
}

function compareBySortOption(a: SessionHistoryRecord, b: SessionHistoryRecord, sortBy: string | undefined): number {
	switch (sortBy) {
		case "oldest":
			return sessionRecordLastActiveTs(a) - sessionRecordLastActiveTs(b)
		case "mostExpensive":
			return readTaskUsageTotals(b.metadata).totalCost - readTaskUsageTotals(a.metadata).totalCost
		case "mostTokens":
			return totalTokens(b) - totalTokens(a)
		default:
			return sessionRecordLastActiveTs(b) - sessionRecordLastActiveTs(a)
	}
}

function comparePinnedFirst(a: SessionHistoryRecord, b: SessionHistoryRecord, sortBy: string | undefined): number {
	return Number(isSessionRecordPinned(b)) - Number(isSessionRecordPinned(a)) || compareBySortOption(a, b, sortBy)
}

/**
 * The conversations that match `query`, pinned ones first and each part in
 * the query's sort order. Callers page the result: filtering has to see the
 * whole history, because the matches may all be older than the newest page.
 */
export function queryTaskHistory(records: SessionHistoryRecord[], query: TaskHistoryQuery): SessionHistoryRecord[] {
	return records
		.filter((record) => taskHistoryRowMatches(sessionRecordToRow(record), query))
		.sort((a, b) => comparePinnedFirst(a, b, query.sortBy))
}

/** A conversation whose messages match the search, from the full-text index. */
interface ContentMatch {
	sessionId: string
	/** The matching text, with the matched words in [brackets]. */
	snippet: string
}

interface TaskHistoryResult {
	records: SessionHistoryRecord[]
	/** Per conversation found by its messages only: the text that matched. */
	snippets: Map<string, string>
}

/**
 * queryTaskHistory, plus the conversations found by message text
 * (`contentMatches`, best first) that pass every other filter. Title and path
 * matches come first; content-only matches follow, in the index's relevance
 * order under "Most Relevant" and in the chosen sort order otherwise.
 */
export function queryTaskHistoryWithContent(
	records: SessionHistoryRecord[],
	query: TaskHistoryQuery,
	contentMatches: readonly ContentMatch[],
): TaskHistoryResult {
	const titleMatches = queryTaskHistory(records, query)
	const snippets = new Map<string, string>()
	if (contentMatches.length === 0 || !query.searchQuery?.trim()) {
		return { records: titleMatches, snippets }
	}
	const listed = new Set(titleMatches.map((record) => record.sessionId))
	const byId = new Map(records.map((record) => [record.sessionId, record]))
	const otherFilters: TaskHistoryQuery = { ...query, searchQuery: undefined }
	const contentOnly: SessionHistoryRecord[] = []
	for (const match of contentMatches) {
		const record = byId.get(match.sessionId)
		if (!record || listed.has(match.sessionId) || !taskHistoryRowMatches(sessionRecordToRow(record), otherFilters)) {
			continue
		}
		listed.add(match.sessionId)
		contentOnly.push(record)
		snippets.set(match.sessionId, match.snippet)
	}
	if (query.sortBy && query.sortBy !== "mostRelevant") {
		contentOnly.sort((a, b) => comparePinnedFirst(a, b, query.sortBy))
	}
	return { records: [...titleMatches, ...contentOnly], snippets }
}
