import type { SessionHistoryRecord } from "@plinycode/core"
import { arePathsEqual } from "@/utils/path"
import {
	dateStringToTimestamp,
	metadataBoolean,
	metadataNumber,
	metadataString,
	sessionRecordWorkspacePath,
} from "./sdk-task-history"

/** The filters and sort order of the history view (the getTaskHistory RPC). */
export interface TaskHistoryQuery {
	favoritesOnly?: boolean
	/** Every whitespace-separated term must appear in the title or the workspace path, in any case. */
	searchQuery?: string
	/** "newest" (the default), "oldest", "mostExpensive" or "mostTokens". */
	sortBy?: string
	/** Only conversations bound to this workspace. */
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
	return {
		title: sessionRecordTitle(record),
		workspacePath: sessionRecordWorkspacePath(record),
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
	if (query.workspacePath && (!row.workspacePath || !arePathsEqual(row.workspacePath, query.workspacePath))) {
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
		const haystack = `${row.title}\n${row.workspacePath}`.toLowerCase()
		if (!terms.every((term) => haystack.includes(term))) {
			return false
		}
	}
	return true
}

function totalTokens(record: SessionHistoryRecord): number {
	return (
		(metadataNumber(record.metadata, "tokensIn") ?? 0) +
		(metadataNumber(record.metadata, "tokensOut") ?? 0) +
		(metadataNumber(record.metadata, "cacheWrites") ?? 0) +
		(metadataNumber(record.metadata, "cacheReads") ?? 0)
	)
}

function compareBySortOption(a: SessionHistoryRecord, b: SessionHistoryRecord, sortBy: string | undefined): number {
	switch (sortBy) {
		case "oldest":
			return sessionRecordLastActiveTs(a) - sessionRecordLastActiveTs(b)
		case "mostExpensive":
			return (metadataNumber(b.metadata, "totalCost") ?? 0) - (metadataNumber(a.metadata, "totalCost") ?? 0)
		case "mostTokens":
			return totalTokens(b) - totalTokens(a)
		default:
			return sessionRecordLastActiveTs(b) - sessionRecordLastActiveTs(a)
	}
}

/**
 * The conversations that match `query`, pinned ones first and each part in
 * the query's sort order. Callers page the result: filtering has to see the
 * whole history, because the matches may all be older than the newest page.
 */
export function queryTaskHistory(records: SessionHistoryRecord[], query: TaskHistoryQuery): SessionHistoryRecord[] {
	return records
		.filter((record) => taskHistoryRowMatches(sessionRecordToRow(record), query))
		.sort(
			(a, b) =>
				Number(isSessionRecordPinned(b)) - Number(isSessionRecordPinned(a)) || compareBySortOption(a, b, query.sortBy),
		)
}
