import { promises as fs } from "node:fs"
import path from "node:path"
import { resolveClineDataDir } from "@plinycode/shared/storage"
import { MAX_RECENT_WORKSPACES, parseWorkspaceKind, pushRecentWorkspace, type WorkspaceRef } from "@shared/workspaceRef"
import { Logger } from "@/shared/services/Logger"

/**
 * The most recently used workspaces, shared by every PlinyCode window on the
 * machine. Unlike `StateManager` keys, which each window caches at startup,
 * this store is a small JSON file under the shared data directory that is
 * re-read on every call, so a workspace used in one window shows up in the
 * others' pickers right away.
 */
export class RecentWorkspacesStore {
	private writeQueue: Promise<void> = Promise.resolve()

	constructor(private readonly filePath: string = path.join(resolveClineDataDir(), "recent-workspaces.json")) {}

	/** Newest first, at most `MAX_RECENT_WORKSPACES`. Never throws. */
	async list(): Promise<WorkspaceRef[]> {
		try {
			const raw = await fs.readFile(this.filePath, "utf8")
			const parsed: unknown = JSON.parse(raw)
			const entries = Array.isArray(parsed) ? parsed : ((parsed as { workspaces?: unknown })?.workspaces ?? [])
			if (!Array.isArray(entries)) {
				return []
			}
			return entries
				.map(toWorkspaceRef)
				.filter((entry): entry is WorkspaceRef => entry !== undefined)
				.slice(0, MAX_RECENT_WORKSPACES)
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				Logger.warn("[RecentWorkspacesStore] Failed to read recent workspaces:", error)
			}
			return []
		}
	}

	/** Records `ref` as the most recently used workspace. Never throws. */
	async touch(ref: WorkspaceRef, now = Date.now()): Promise<WorkspaceRef[]> {
		const run = this.writeQueue.then(async () => {
			const next = pushRecentWorkspace(await this.list(), ref, now)
			await this.write(next)
			return next
		})
		this.writeQueue = run.then(
			() => undefined,
			() => undefined,
		)
		try {
			return await run
		} catch (error) {
			Logger.warn("[RecentWorkspacesStore] Failed to record recent workspace:", error)
			return this.list()
		}
	}

	private async write(entries: WorkspaceRef[]): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true })
		// Write-then-rename so a window reading concurrently never sees a torn file.
		const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
		await fs.writeFile(tempPath, JSON.stringify({ version: 1, workspaces: entries }, null, 2), "utf8")
		try {
			await fs.rename(tempPath, this.filePath)
		} catch (error) {
			await fs.rm(tempPath, { force: true }).catch(() => undefined)
			throw error
		}
	}
}

function toWorkspaceRef(value: unknown): WorkspaceRef | undefined {
	if (!value || typeof value !== "object") {
		return undefined
	}
	const entry = value as { path?: unknown; kind?: unknown; folders?: unknown; lastUsedTs?: unknown }
	const workspacePath = typeof entry.path === "string" ? entry.path.trim() : ""
	if (!workspacePath) {
		return undefined
	}
	const folders = Array.isArray(entry.folders)
		? entry.folders.filter((folder): folder is string => typeof folder === "string" && folder.trim().length > 0)
		: []
	const kind = parseWorkspaceKind(typeof entry.kind === "string" ? entry.kind : undefined)
	return {
		path: workspacePath,
		kind,
		folders: folders.length > 0 ? folders : kind === "folder" ? [workspacePath] : [],
		...(typeof entry.lastUsedTs === "number" && Number.isFinite(entry.lastUsedTs) ? { lastUsedTs: entry.lastUsedTs } : {}),
	}
}
