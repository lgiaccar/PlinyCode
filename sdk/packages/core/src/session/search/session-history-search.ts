import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
	formatSessionSearchPreview,
	formatSessionSearchTitle,
	stripModeNotices,
} from "@plinycode/shared";
import { loadSqliteDb, nowIso, type SqliteDb } from "@plinycode/shared/db";
import { resolveDbDataDir } from "@plinycode/shared/storage";
import type { RuntimeHost } from "../../runtime/host/runtime-host";
import type { SessionRecord } from "../../types/sessions";
import { offTheRecordMessageIndices } from "../off-the-record";

// 3: side-question (off-the-record) turns are left out of the index.
// 4: workspace roots are stored normalized (normalizeWorkspaceRoot), and the
//    editor-state and mode-notice blocks are left out of message text.
const INDEX_VERSION = 4;
const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60_000;
const MAX_INDEXED_TEXT_LENGTH = 128 * 1024;
const MAX_SEARCH_CANDIDATES = 2_000;

// Size limits: the index keeps the most recently active conversations within
// both caps and drops the oldest first.
const DEFAULT_MAX_INDEXED_SESSIONS = 20_000;
const DEFAULT_MAX_DATABASE_BYTES = 200 * 1024 * 1024;
// When the database outgrows its byte cap, the session cap is set so the index
// fills this share of it, leaving room for the conversations that follow; it
// is raised again only once the database is below the lower share.
const SIZE_CAP_FILL = 0.9;
const SIZE_CAP_GROW_BELOW = 0.6;
// Compaction (FTS5 optimize, then VACUUM) runs after evictions that removed a
// meaningful share of the indexed documents, and otherwise at most weekly when
// anything was removed or re-indexed since the last one.
const DEFAULT_MAINTENANCE_INTERVAL_MS = 7 * 24 * 60 * 60_000;
const MEANINGFUL_EVICTED_DOCUMENTS = 500;
const MEANINGFUL_EVICTED_SHARE = 0.1;
// After a failed compaction (another window holding the database), wait this long.
const MAINTENANCE_RETRY_MS = 60 * 60_000;
// FTS5 weights are positional and include the five UNINDEXED metadata columns.
const SESSION_SEARCH_RANKING = "bm25(0, 0, 0, 0, 0, 0.5, 8.0, 1.0)";

export interface SessionSearchInput {
	query: string;
	limit?: number;
	workspaceRoot?: string;
}

export interface SessionSearchHit {
	sessionId: string;
	documentId: string;
	ordinal: number;
	role: string;
	startedAt: string;
	workspaceRoot: string;
	title: string;
	snippet: string;
	score: number;
}

export interface SessionHistorySearchOptions {
	dbPath?: string;
	reconcileIntervalMs?: number;
	/** Most conversations indexed; the least recently active go first. Default 20,000. */
	maxSessions?: number;
	/** Largest the database may grow (live pages); the least recently active conversations go first. Default 200 MB. */
	maxDatabaseBytes?: number;
	/** Longest time between compactions while anything changed. Default a week. */
	maintenanceIntervalMs?: number;
	/** Clock, for tests. */
	now?: () => number;
}

/** What the index holds, for diagnostics and tests. */
export interface SessionSearchIndexStats {
	sessions: number;
	documents: number;
	/** Bytes in live database pages: the measure the byte cap applies to. */
	usedBytes: number;
	/** The session cap the byte cap set, when it set one. */
	sessionCap?: number;
	/** Documents evicted since the last compaction. */
	evictedDocuments: number;
	/** When the last compaction ran (ms since epoch). */
	lastMaintenanceAt?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

interface SearchableTextAccumulator {
	length: number;
	parts: string[];
}

function appendSearchableText(
	value: unknown,
	output: SearchableTextAccumulator,
): void {
	if (output.length >= MAX_INDEXED_TEXT_LENGTH) return;
	if (typeof value === "string") {
		const separatorLength = output.parts.length > 0 ? 1 : 0;
		const remaining = MAX_INDEXED_TEXT_LENGTH - output.length - separatorLength;
		if (remaining <= 0) return;
		const part = value.slice(0, remaining);
		if (!part) return;
		output.parts.push(part);
		output.length += separatorLength + part.length;
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) appendSearchableText(item, output);
		return;
	}
	const record = asRecord(value);
	if (!record) return;
	for (const [key, item] of Object.entries(record)) {
		if (
			key === "data" ||
			key === "image" ||
			key === "images" ||
			key === "reasoning" ||
			key === "thinking" ||
			key === "metadata"
		) {
			continue;
		}
		appendSearchableText(item, output);
	}
}

function messageText(message: unknown): string {
	const record = asRecord(message);
	const output: SearchableTextAccumulator = { length: 0, parts: [] };
	appendSearchableText(record?.content ?? message, output);
	// The editor state a host appends to typed messages (open tabs, cursor)
	// and mode notices are not what the user said: indexed, every open file
	// name matched a search.
	return stripModeNotices(output.parts.join("\n"));
}

/**
 * A workspace root as the index stores and compares it: forward slashes, no
 * trailing slash, and lower case on Windows, where the same folder can reach
 * the index as `D:\repo` from one window and `d:/repo/` from another. The
 * folder filter compares with plain equality, so roots must agree first.
 */
export function normalizeWorkspaceRoot(root: string | undefined): string {
	const trimmed = (root ?? "").trim();
	if (!trimmed) return "";
	const slashed = trimmed.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
	return /^[a-zA-Z]:/.test(slashed) || process.platform === "win32"
		? slashed.toLowerCase()
		: slashed;
}

function messageRole(message: unknown): string {
	const role = asRecord(message)?.role;
	return typeof role === "string" ? role : "unknown";
}

function sessionTitle(session: SessionRecord): string {
	const title = session.metadata?.title;
	const source =
		typeof title === "string" && title.trim()
			? title
			: session.prompt || session.sessionId;
	return formatSessionSearchTitle(source) || session.sessionId;
}

function ftsQuery(query: string): string {
	return query
		.trim()
		.split(/\s+/u)
		.filter(Boolean)
		.map((token) => `"${token.replaceAll('"', '""')}"*`)
		.join(" AND ");
}

function ensureSearchSchema(db: SqliteDb): void {
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA busy_timeout = 5000;");
	db.exec(`CREATE TABLE IF NOT EXISTS indexed_sessions (
		session_id TEXT PRIMARY KEY,
		source_revision TEXT NOT NULL,
		indexed_at TEXT NOT NULL,
		document_count INTEGER NOT NULL,
		index_version INTEGER NOT NULL,
		title TEXT NOT NULL DEFAULT ''
	);`);
	const indexedSessionColumns = new Set(
		(
			db.prepare("PRAGMA table_info(indexed_sessions)").all() as Array<{
				name: string;
			}>
		).map((column) => column.name),
	);
	if (!indexedSessionColumns.has("title")) {
		db.exec(
			"ALTER TABLE indexed_sessions ADD COLUMN title TEXT NOT NULL DEFAULT '';",
		);
	}
	db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5(
		session_id UNINDEXED,
		document_id UNINDEXED,
		ordinal UNINDEXED,
		role UNINDEXED,
		started_at UNINDEXED,
		workspace_root,
		title,
		content,
		tokenize='unicode61 remove_diacritics 2 tokenchars ''_-@'''
	);`);
	db.exec(`CREATE TABLE IF NOT EXISTS search_meta (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);`);
}

function readMetaNumber(db: SqliteDb, key: string): number | undefined {
	const row = db
		.prepare("SELECT value FROM search_meta WHERE key = ?")
		.get(key) as Record<string, unknown> | null | undefined;
	const value = Number(row?.value);
	return row && Number.isFinite(value) ? value : undefined;
}

function writeMeta(db: SqliteDb, key: string, value: string): void {
	db.prepare(
		"INSERT INTO search_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(key, value);
}

function deleteMeta(db: SqliteDb, key: string): void {
	db.prepare("DELETE FROM search_meta WHERE key = ?").run(key);
}

function addMetaNumber(db: SqliteDb, key: string, amount: number): void {
	if (amount > 0) {
		writeMeta(db, key, String((readMetaNumber(db, key) ?? 0) + amount));
	}
}

function pragmaNumber(db: SqliteDb, pragma: string): number {
	const row = db.prepare(`PRAGMA ${pragma}`).get() as
		| Record<string, unknown>
		| null
		| undefined;
	return Number(row ? Object.values(row)[0] : 0) || 0;
}

/** Bytes in the database's live pages: its size once compacted. */
function usedDatabaseBytes(db: SqliteDb): number {
	return (
		Math.max(
			0,
			pragmaNumber(db, "page_count") - pragmaNumber(db, "freelist_count"),
		) * pragmaNumber(db, "page_size")
	);
}

function countIndexedSessions(db: SqliteDb): number {
	const row = db
		.prepare("SELECT COUNT(*) AS count FROM indexed_sessions")
		.get() as Record<string, unknown> | null | undefined;
	return Number(row?.count ?? 0);
}

function countIndexedDocuments(db: SqliteDb): number {
	const row = db
		.prepare(
			"SELECT COALESCE(SUM(document_count), 0) AS count FROM indexed_sessions",
		)
		.get() as Record<string, unknown> | null | undefined;
	return Number(row?.count ?? 0);
}

/** The least recently active last; a conversation continued today counts as recent however old it is. */
function byRecencyDesc(a: SessionRecord, b: SessionRecord): number {
	const time = (session: SessionRecord) =>
		Date.parse(session.updatedAt || session.startedAt) || 0;
	return time(b) - time(a);
}

function initializeSearchDatabase(dbPath: string): {
	db?: SqliteDb;
	error?: unknown;
} {
	let db: SqliteDb | undefined;
	try {
		db = loadSqliteDb(dbPath);
		ensureSearchSchema(db);
		return { db };
	} catch (error) {
		try {
			db?.close?.();
		} catch {
			// The database is already unavailable; preserve the initialization error.
		}
		return {
			error:
				error ?? new Error("Session search database initialization failed"),
		};
	}
}

export class SessionHistorySearchService {
	private readonly db: SqliteDb | undefined;
	private readonly initializationError: unknown | undefined;
	private readonly intervalMs: number;
	private readonly maxSessions: number;
	private readonly maxDatabaseBytes: number;
	private readonly maintenanceIntervalMs: number;
	private readonly now: () => number;
	private nextMaintenanceAttemptAt = 0;
	private readonly removedDuringRefresh = new Set<string>();
	private readonly failedEvictionSessionIds = new Set<string>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private refreshPromise: Promise<void> | undefined;
	private readyPromise: Promise<void> = Promise.resolve();

	constructor(
		private readonly host: Pick<
			RuntimeHost,
			"listSessions" | "readSessionMessages"
		>,
		options: SessionHistorySearchOptions = {},
	) {
		const initialized = initializeSearchDatabase(
			options.dbPath ?? join(resolveDbDataDir(), "session-search.db"),
		);
		this.db = initialized.db;
		this.initializationError = initialized.error;
		this.intervalMs =
			options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
		this.maxSessions = Math.max(
			1,
			Math.trunc(options.maxSessions ?? DEFAULT_MAX_INDEXED_SESSIONS),
		);
		this.maxDatabaseBytes =
			options.maxDatabaseBytes ?? DEFAULT_MAX_DATABASE_BYTES;
		this.maintenanceIntervalMs =
			options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
		this.now = options.now ?? Date.now;
	}

	/** Counts and sizes of the index; undefined without SQLite. */
	stats(): SessionSearchIndexStats | undefined {
		const db = this.db;
		if (!db) return undefined;
		const totals = db
			.prepare(
				"SELECT COUNT(*) AS sessions, COALESCE(SUM(document_count), 0) AS documents FROM indexed_sessions",
			)
			.get() as Record<string, unknown> | undefined;
		return {
			sessions: Number(totals?.sessions ?? 0),
			documents: Number(totals?.documents ?? 0),
			usedBytes: usedDatabaseBytes(db),
			sessionCap: readMetaNumber(db, "session_cap"),
			evictedDocuments: readMetaNumber(db, "evicted_documents") ?? 0,
			lastMaintenanceAt: readMetaNumber(db, "last_maintenance_at"),
		};
	}

	start(): void {
		if (!this.db) return;
		this.readyPromise = this.refreshNow();
		void this.readyPromise.catch((error) =>
			console.warn("[hub] session search indexing failed", error),
		);
		this.timer = setInterval(() => {
			void this.refreshNow().catch((error) =>
				console.warn("[hub] session search reconciliation failed", error),
			);
		}, this.intervalMs);
		this.timer.unref?.();
	}

	async dispose(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.refreshPromise?.catch(() => undefined);
		this.db?.close?.();
	}

	refreshNow(): Promise<void> {
		const db = this.db;
		if (!db) return Promise.resolve();
		if (!this.refreshPromise) {
			this.refreshPromise = this.reconcile(db).finally(() => {
				this.removedDuringRefresh.clear();
				this.refreshPromise = undefined;
			});
		}
		return this.refreshPromise;
	}

	/**
	 * Removes one session from the derived index without scanning canonical
	 * history. The temporary tombstone prevents an in-flight reconciliation
	 * that captured the session before deletion from writing it back.
	 */
	removeSession(sessionId: string): void {
		const db = this.db;
		if (!db) return;
		const normalized = sessionId.trim();
		if (!normalized) return;
		if (this.refreshPromise) this.removedDuringRefresh.add(normalized);
		try {
			const removed = this.deleteIndexedSession(db, normalized);
			this.failedEvictionSessionIds.delete(normalized);
			addMetaNumber(db, "evicted_documents", removed);
		} catch (error) {
			// Keep failed evictions hidden until reconciliation can retry the
			// disposable database cleanup successfully.
			this.failedEvictionSessionIds.add(normalized);
			throw error;
		}
	}

	async waitUntilReady(): Promise<void> {
		await this.readyPromise;
	}

	isAvailable(): boolean {
		return this.db !== undefined;
	}

	getInitializationError(): unknown | undefined {
		return this.initializationError;
	}

	search(input: SessionSearchInput): SessionSearchHit[] {
		const db = this.db;
		if (!db) return [];
		const query = ftsQuery(input.query);
		if (!query) return [];
		const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200);
		// Bound per-session deduplication work for broad queries while scanning
		// enough ranked candidates to keep chatty sessions from crowding the list.
		const candidateLimit = Math.min(
			Math.max(limit * 20, 200),
			MAX_SEARCH_CANDIDATES,
		);
		const workspaceRoot =
			normalizeWorkspaceRoot(input.workspaceRoot) || undefined;
		const rows = db
			.prepare(
				`WITH matches AS MATERIALIZED (
					SELECT session_search.session_id, document_id, ordinal, role, started_at,
						workspace_root, indexed_sessions.title,
						snippet(session_search, 7, '[', ']', '…', 24) AS snippet,
						session_search.rank AS score
					FROM session_search
					JOIN indexed_sessions
						ON indexed_sessions.session_id = session_search.session_id
					WHERE session_search MATCH ?
						AND session_search.rank MATCH ?
						AND (? IS NULL OR workspace_root = ?)
					ORDER BY score, started_at DESC
					LIMIT ?
				), ranked AS (
					SELECT *, ROW_NUMBER() OVER (
						PARTITION BY session_id ORDER BY score, ordinal
					) AS session_rank
					FROM matches
				)
				SELECT session_id, document_id, ordinal, role, started_at,
					workspace_root, title, snippet, score
				FROM ranked
				WHERE session_rank = 1
				ORDER BY score, started_at DESC
				LIMIT ?`,
			)
			.all(
				query,
				SESSION_SEARCH_RANKING,
				workspaceRoot ?? null,
				workspaceRoot ?? null,
				candidateLimit,
				limit,
			) as Array<Record<string, unknown>>;
		const visibleRows =
			this.removedDuringRefresh.size === 0 &&
			this.failedEvictionSessionIds.size === 0
				? rows
				: rows.filter(
						(row) => !this.isSessionSuppressed(String(row.session_id)),
					);
		return visibleRows.map((row) => {
			const role = String(row.role);
			return {
				sessionId: String(row.session_id),
				documentId: String(row.document_id),
				ordinal: Number(row.ordinal),
				role,
				startedAt: String(row.started_at),
				workspaceRoot: String(row.workspace_root),
				title: formatSessionSearchTitle(String(row.title)),
				snippet: formatSessionSearchPreview(role, String(row.snippet ?? "")),
				score: Number(row.score),
			};
		});
	}

	private isSessionSuppressed(sessionId: string): boolean {
		return (
			this.removedDuringRefresh.has(sessionId) ||
			this.failedEvictionSessionIds.has(sessionId)
		);
	}

	private async reconcile(db: SqliteDb): Promise<void> {
		// The most recently active conversations within the session cap, and
		// within the smaller cap the byte cap set when the database outgrew it.
		const listed = [...(await this.host.listSessions(this.maxSessions))]
			.sort(byRecencyDesc)
			.slice(0, this.maxSessions);
		const sizeCap = readMetaNumber(db, "session_cap");
		const sessions =
			sizeCap === undefined ? listed : listed.slice(0, Math.max(1, sizeCap));
		const liveIds = new Set(sessions.map((session) => session.sessionId));
		const indexed = db
			.prepare(
				"SELECT session_id, source_revision, index_version, document_count FROM indexed_sessions",
			)
			.all() as Array<Record<string, unknown>>;
		const indexedById = new Map(
			indexed.map((row) => [String(row.session_id), row] as const),
		);
		let evicted = 0;
		let replaced = 0;

		for (const session of sessions) {
			if (this.isSessionSuppressed(session.sessionId)) continue;
			const revision = await this.sourceRevision(session);
			if (this.isSessionSuppressed(session.sessionId)) continue;
			const current = indexedById.get(session.sessionId);
			if (
				current?.source_revision === revision &&
				Number(current.index_version) === INDEX_VERSION
			) {
				continue;
			}
			replaced += Number(current?.document_count ?? 0);
			await this.indexSession(db, session, revision);
		}

		for (const row of indexed) {
			const sessionId = String(row.session_id);
			if (!liveIds.has(sessionId) || this.isSessionSuppressed(sessionId)) {
				evicted += this.deleteIndexedSession(db, sessionId);
				this.failedEvictionSessionIds.delete(sessionId);
			}
		}
		addMetaNumber(db, "evicted_documents", evicted);
		addMetaNumber(db, "replaced_documents", replaced);
		const currentIndexedSession = db.prepare(
			"SELECT 1 FROM indexed_sessions WHERE session_id = ? LIMIT 1",
		);
		for (const sessionId of this.failedEvictionSessionIds) {
			// `indexedById` is a snapshot captured before this reconciliation may
			// have indexed the session. Re-check the database so a concurrent failed
			// eviction cannot lose its suppression marker after inserting a new row.
			if (!currentIndexedSession.get(sessionId)) {
				this.failedEvictionSessionIds.delete(sessionId);
			}
		}
		this.enforceSizeCap(db, listed, sessions);
		this.maybeMaintain(db);
	}

	/**
	 * Keeps the database within its byte cap. Over it, the index is compacted
	 * first (deleted rows only leave the file then), and if it is still over,
	 * the session cap is lowered so the index fills SIZE_CAP_FILL of the byte
	 * cap, the least recently active conversations are evicted, and the index
	 * is compacted again. Well below the cap, a session cap set earlier is
	 * raised in proportion, so later reconciliations index more again.
	 */
	private enforceSizeCap(
		db: SqliteDb,
		listed: readonly SessionRecord[],
		kept: readonly SessionRecord[],
	): void {
		let used = usedDatabaseBytes(db);
		const sizeCap = readMetaNumber(db, "session_cap");
		if (used > this.maxDatabaseBytes) {
			this.maintain(db);
			used = usedDatabaseBytes(db);
			if (used <= this.maxDatabaseBytes) return;
			const indexedCount = countIndexedSessions(db);
			const cap = Math.max(
				1,
				Math.floor(
					(indexedCount * SIZE_CAP_FILL * this.maxDatabaseBytes) / used,
				),
			);
			writeMeta(db, "session_cap", String(cap));
			let evicted = 0;
			for (const session of kept.slice(cap)) {
				evicted += this.deleteIndexedSession(db, session.sessionId);
			}
			addMetaNumber(db, "evicted_documents", evicted);
			this.maintain(db);
			return;
		}
		if (
			sizeCap !== undefined &&
			used < SIZE_CAP_GROW_BELOW * this.maxDatabaseBytes
		) {
			const indexedCount = countIndexedSessions(db);
			const grown = Math.floor(
				(Math.max(indexedCount, 1) * SIZE_CAP_FILL * this.maxDatabaseBytes) /
					Math.max(used, 1),
			);
			if (grown >= listed.length) {
				deleteMeta(db, "session_cap");
			} else if (grown > sizeCap) {
				writeMeta(db, "session_cap", String(grown));
			}
		}
	}

	/**
	 * Compacts the index when evictions removed a meaningful share of it, or
	 * when the maintenance interval passed and anything was removed or
	 * re-indexed since the last compaction.
	 */
	private maybeMaintain(db: SqliteDb): void {
		const now = this.now();
		const last = readMetaNumber(db, "last_maintenance_at");
		if (last === undefined) {
			// A new index has nothing to compact; the interval starts now.
			writeMeta(db, "last_maintenance_at", String(now));
			return;
		}
		const evicted = readMetaNumber(db, "evicted_documents") ?? 0;
		const replaced = readMetaNumber(db, "replaced_documents") ?? 0;
		const documents = countIndexedDocuments(db);
		const meaningful =
			evicted >= MEANINGFUL_EVICTED_DOCUMENTS &&
			evicted >= MEANINGFUL_EVICTED_SHARE * (documents + evicted);
		const due =
			now - last >= this.maintenanceIntervalMs && evicted + replaced > 0;
		if (meaningful || due) {
			this.maintain(db);
		}
	}

	/**
	 * FTS5 `optimize` merges the index segments, so deleted rows stop taking
	 * space, and VACUUM gives the freed pages back to the file system. Both
	 * need the database to themselves: when another window holds it, the
	 * attempt is retried after MAINTENANCE_RETRY_MS.
	 */
	private maintain(db: SqliteDb): void {
		const now = this.now();
		if (now < this.nextMaintenanceAttemptAt) return;
		try {
			db.exec("INSERT INTO session_search(session_search) VALUES('optimize');");
			db.exec("VACUUM;");
			db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
			writeMeta(db, "evicted_documents", "0");
			writeMeta(db, "replaced_documents", "0");
			writeMeta(db, "last_maintenance_at", String(now));
		} catch (error) {
			this.nextMaintenanceAttemptAt = now + MAINTENANCE_RETRY_MS;
			console.warn("[hub] session search compaction failed", error);
		}
	}

	private async sourceRevision(session: SessionRecord): Promise<string> {
		if (!session.messagesPath) return `${session.updatedAt}:missing`;
		const file = await stat(session.messagesPath).catch(() => undefined);
		return `${session.updatedAt}:${file?.size ?? 0}:${file?.mtimeMs ?? 0}`;
	}

	private async indexSession(
		db: SqliteDb,
		session: SessionRecord,
		revision: string,
	): Promise<void> {
		const messages = await this.host
			.readSessionMessages(session.sessionId)
			.catch(() => []);
		if (this.removedDuringRefresh.has(session.sessionId)) return;
		const title = sessionTitle(session);
		const insert = db.prepare(
			`INSERT INTO session_search (
				session_id, document_id, ordinal, role, started_at,
				workspace_root, title, content
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		db.exec("BEGIN IMMEDIATE;");
		try {
			db.prepare("DELETE FROM session_search WHERE session_id = ?").run(
				session.sessionId,
			);
			insert.run(
				session.sessionId,
				`${session.sessionId}:metadata`,
				-1,
				"session",
				session.startedAt,
				normalizeWorkspaceRoot(session.workspaceRoot),
				title,
				session.prompt?.trim() ?? "",
			);
			let count = 1;
			// Side questions are asked off the record: they stay out of search
			// too. Skipped rather than removed, so ordinals still match the
			// transcript.
			const offTheRecord = offTheRecordMessageIndices(messages);
			for (const [ordinal, message] of messages.entries()) {
				if (offTheRecord.has(ordinal)) continue;
				const content = messageText(message);
				if (!content) continue;
				insert.run(
					session.sessionId,
					`${session.sessionId}:${ordinal}`,
					ordinal,
					messageRole(message),
					session.startedAt,
					normalizeWorkspaceRoot(session.workspaceRoot),
					"",
					content,
				);
				count += 1;
			}
			db.prepare(
				`INSERT INTO indexed_sessions (
						session_id, source_revision, indexed_at, document_count, index_version, title
					) VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT(session_id) DO UPDATE SET
						source_revision = excluded.source_revision,
						indexed_at = excluded.indexed_at,
						document_count = excluded.document_count,
						index_version = excluded.index_version,
						title = excluded.title`,
			).run(session.sessionId, revision, nowIso(), count, INDEX_VERSION, title);
			db.exec("COMMIT;");
		} catch (error) {
			db.exec("ROLLBACK;");
			throw error;
		}
	}

	/** Removes one session's rows; returns how many documents it had. */
	private deleteIndexedSession(db: SqliteDb, sessionId: string): number {
		const row = db
			.prepare(
				"SELECT document_count FROM indexed_sessions WHERE session_id = ?",
			)
			.get(sessionId) as Record<string, unknown> | undefined;
		db.exec("BEGIN IMMEDIATE;");
		try {
			db.prepare("DELETE FROM session_search WHERE session_id = ?").run(
				sessionId,
			);
			db.prepare("DELETE FROM indexed_sessions WHERE session_id = ?").run(
				sessionId,
			);
			db.exec("COMMIT;");
		} catch (error) {
			db.exec("ROLLBACK;");
			throw error;
		}
		return Number(row?.document_count ?? 0);
	}
}
