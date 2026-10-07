import { promises as fs } from "node:fs"
import path from "node:path"
import { workspacePathsEqual } from "@shared/workspacePath"
import { Logger } from "@/shared/services/Logger"
import type { CiAction, CiLink, CiTarget } from "./types"

/** One window workspace's board. */
interface CiBoardData {
	targets: CiTarget[]
	/** The conversation last started for each item, by item key. */
	links: Record<string, CiLink>
}

interface CiBoardFile {
	version: 1
	boards: Record<string, CiBoardData>
}

const empty = (): CiBoardData => ({ targets: [], links: {} })

/**
 * The boards of every window workspace, in one JSON file under the shared data
 * directory. Like `RecentWorkspacesStore`, it is re-read on every call (each
 * window caches `StateManager` keys at startup, so two windows would overwrite
 * each other's boards there) and written write-then-rename. A board belongs to
 * the window workspace it was made in, so each window polls only its own.
 */
export class CiBoardStore {
	private writeQueue: Promise<void> = Promise.resolve()

	constructor(private readonly filePath: string) {}

	/** Never throws: a missing or unreadable file is an empty board. */
	async load(workspace: string): Promise<CiBoardData> {
		const file = await this.read()
		const key = Object.keys(file.boards).find((k) => workspacePathsEqual(k, workspace))
		return key ? sanitize(file.boards[key]) : empty()
	}

	/** Applies `change` to the workspace's board as it is on disk now, and saves it. */
	async update(workspace: string, change: (data: CiBoardData) => CiBoardData): Promise<CiBoardData> {
		const run = this.writeQueue.then(async () => {
			const file = await this.read()
			const key = Object.keys(file.boards).find((k) => workspacePathsEqual(k, workspace)) ?? workspace
			const next = change(sanitize(file.boards[key]))
			file.boards[key] = next
			await this.write(file)
			return next
		})
		this.writeQueue = run.then(
			() => undefined,
			() => undefined,
		)
		return run
	}

	private async read(): Promise<CiBoardFile> {
		try {
			const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"))
			const boards = parsed && typeof parsed === "object" ? parsed.boards : undefined
			return { version: 1, boards: boards && typeof boards === "object" && !Array.isArray(boards) ? boards : {} }
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				Logger.warn("[CiBoardStore] Failed to read the CI board:", error)
			}
			return { version: 1, boards: {} }
		}
	}

	private async write(file: CiBoardFile): Promise<void> {
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

function sanitize(value: unknown): CiBoardData {
	if (!value || typeof value !== "object") {
		return empty()
	}
	const data = value as { targets?: unknown; links?: unknown }
	const targets = Array.isArray(data.targets) ? data.targets.filter(isTarget) : []
	const links: Record<string, CiLink> = {}
	if (data.links && typeof data.links === "object") {
		for (const [key, link] of Object.entries(data.links as Record<string, unknown>)) {
			if (link && typeof link === "object" && isString((link as CiLink).conversationId)) {
				links[key] = link as CiLink
			}
		}
	}
	return { targets, links }
}

function isTarget(value: unknown): value is CiTarget {
	if (!value || typeof value !== "object") {
		return false
	}
	const t = value as Partial<CiTarget>
	return (
		isString(t.id) &&
		(t.kind === "pr" || t.kind === "branch" || t.kind === "repo") &&
		isString(t.remoteUrl) &&
		(t.provider === "github" || t.provider === "ado") &&
		Array.isArray(t.actions) &&
		t.actions.every(isAction)
	)
}

function isAction(value: unknown): value is CiAction {
	const a = value as Partial<CiAction> | undefined
	return !!a && isString(a.id) && isString(a.label) && !!a.prompt && typeof a.prompt === "object"
}
