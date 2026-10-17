/**
 * Saves the CI watches of each window workspace, so a pending watch, its
 * wake-up count and a report waiting for its conversation survive a window
 * reload (docs/devops-mcp.md). One JSON file under the shared data directory,
 * beside `ci-board.json`, re-read before every write and written
 * write-then-rename like `CiBoardStore`. Watches belong to the window workspace
 * that started them, so each window resumes only its own.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { workspacePathsEqual } from "@shared/workspacePath"
import { Logger } from "@/shared/services/Logger"
import type { CiWatchMessage } from "./ci-watch-report"
import type { CiWatchTargetSpec } from "./ci-watch-source"
import type { CiHeadMove, CiWatchUntil } from "./ci-watcher"

/** A pending watch, as saved. */
export interface CiWatchSavedWatch {
	/** "PR #12 (feature → main)" or "branch feature". */
	label: string
	/** "GitHub" or "Azure DevOps". */
	providerKind: string
	target: CiWatchTargetSpec
	until: CiWatchUntil
	/** The last head commit seen. */
	head: string
	/** When that head was first seen; the no-run deadline counts from here. */
	headSince: number
	headMoves: CiHeadMove[]
	startedAt: number
	/** When the watch gives up (startedAt + its maximum length). A watch found past it is dropped. */
	deadline: number
}

/** What is saved for one conversation. A record has at least one of `watch`, `wakeUps` and `held`. */
export interface CiWatchRecord {
	conversationId: string
	watch?: CiWatchSavedWatch
	/** Reports sent to the conversation since the user last wrote in it. */
	wakeUps?: number
	/** A report that waits for the conversation to be opened. */
	held?: CiWatchMessage
}

/** Where the manager saves its watches: the window workspace's part of the file. */
export interface CiWatchPersistence {
	load(): Promise<CiWatchRecord[]>
	save(records: CiWatchRecord[]): Promise<void>
}

const VERSION = 1

interface CiWatchFile {
	version: typeof VERSION
	/** Records per window workspace path ("" for a window with no folder). */
	windows: Record<string, CiWatchRecord[]>
}

export class CiWatchStore implements CiWatchPersistence {
	private writeQueue: Promise<void> = Promise.resolve()

	/** @param workspace the window workspace, as `workspaceRefFromWindow` names it. */
	constructor(
		private readonly filePath: string,
		private readonly workspace: string | Promise<string>,
	) {}

	/** Never throws: a missing or unreadable file has no watches, and invalid records are left out. */
	async load(): Promise<CiWatchRecord[]> {
		const workspace = await this.workspace
		const file = await this.read()
		const key = Object.keys(file.windows).find((k) => workspacePathsEqual(k, workspace))
		return key ? sanitizeRecords(file.windows[key]) : []
	}

	/** Replaces the window workspace's records with `records`, leaving other windows' as they are on disk now. */
	async save(records: CiWatchRecord[]): Promise<void> {
		const workspace = await this.workspace
		const run = this.writeQueue.then(async () => {
			const file = await this.read()
			for (const key of Object.keys(file.windows)) {
				if (workspacePathsEqual(key, workspace)) {
					delete file.windows[key]
				}
			}
			if (records.length > 0) {
				file.windows[workspace] = records
			}
			await this.write(file)
		})
		this.writeQueue = run.then(
			() => undefined,
			() => undefined,
		)
		return run
	}

	private async read(): Promise<CiWatchFile> {
		try {
			const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"))
			if (parsed?.version !== VERSION) {
				Logger.warn(`[CiWatchStore] Ignoring ${this.filePath}: unknown version ${JSON.stringify(parsed?.version)}`)
				return { version: VERSION, windows: {} }
			}
			const windows = parsed.windows
			return {
				version: VERSION,
				windows: windows && typeof windows === "object" && !Array.isArray(windows) ? windows : {},
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				Logger.warn("[CiWatchStore] Failed to read the CI watches:", error)
			}
			return { version: VERSION, windows: {} }
		}
	}

	private async write(file: CiWatchFile): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true })
		const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
		await fs.writeFile(tempPath, JSON.stringify(file, null, 2), "utf8")
		try {
			await fs.rename(tempPath, this.filePath)
		} catch (error) {
			await fs.rm(tempPath, { force: true }).catch(() => undefined)
			throw error
		}
	}
}

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
const isObject = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value)

function sanitizeRecords(value: unknown): CiWatchRecord[] {
	if (!Array.isArray(value)) {
		return []
	}
	const seen = new Set<string>()
	const records: CiWatchRecord[] = []
	for (const entry of value) {
		const record = sanitizeRecord(entry)
		if (record && !seen.has(record.conversationId)) {
			seen.add(record.conversationId)
			records.push(record)
		}
	}
	return records
}

function sanitizeRecord(value: unknown): CiWatchRecord | undefined {
	if (!isObject(value) || !isString(value.conversationId)) {
		return undefined
	}
	const watch = sanitizeWatch(value.watch)
	const wakeUps =
		typeof value.wakeUps === "number" && Number.isInteger(value.wakeUps) && value.wakeUps > 0 ? value.wakeUps : undefined
	const held =
		isObject(value.held) && isString(value.held.headline) && isString(value.held.prompt)
			? { headline: value.held.headline, prompt: value.held.prompt }
			: undefined
	if (!watch && !wakeUps && !held) {
		return undefined
	}
	return {
		conversationId: value.conversationId,
		...(watch ? { watch } : {}),
		...(wakeUps ? { wakeUps } : {}),
		...(held ? { held } : {}),
	}
}

function sanitizeWatch(value: unknown): CiWatchSavedWatch | undefined {
	if (!isObject(value)) {
		return undefined
	}
	const target = sanitizeTarget(value.target)
	const headMoves = Array.isArray(value.headMoves)
		? value.headMoves.filter((move): move is CiHeadMove => isObject(move) && isString(move.from) && isString(move.to))
		: []
	if (
		!target ||
		!isString(value.label) ||
		!isString(value.providerKind) ||
		!(value.until === "finished" || value.until === "first_failure") ||
		!isString(value.head) ||
		!isTime(value.headSince) ||
		!isTime(value.startedAt) ||
		!isTime(value.deadline)
	) {
		return undefined
	}
	return {
		label: value.label,
		providerKind: value.providerKind,
		target,
		until: value.until,
		head: value.head,
		headSince: value.headSince,
		headMoves: headMoves.map(({ from, to }) => ({ from, to })),
		startedAt: value.startedAt,
		deadline: value.deadline,
	}
}

function sanitizeTarget(value: unknown): CiWatchTargetSpec | undefined {
	if (!isObject(value) || !isString(value.cwd) || !isString(value.branch) || !isObject(value.remote)) {
		return undefined
	}
	const remote = value.remote
	if (
		!(remote.kind === "github" || remote.kind === "ado") ||
		!isString(remote.host) ||
		!isString(remote.owner) ||
		!isString(remote.repo)
	) {
		return undefined
	}
	const pr = value.pr
	if (pr !== undefined && !(typeof pr === "number" && Number.isInteger(pr) && pr > 0)) {
		return undefined
	}
	return {
		cwd: value.cwd,
		remote: remote as unknown as CiWatchTargetSpec["remote"],
		...(pr !== undefined ? { pr } : {}),
		branch: value.branch,
	}
}
