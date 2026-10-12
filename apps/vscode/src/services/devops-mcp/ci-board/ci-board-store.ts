import { promises as fs } from "node:fs"
import path from "node:path"
import { workspacePathsEqual } from "@shared/workspacePath"
import { Logger } from "@/shared/services/Logger"
import {
	type CiAction,
	type CiAutoAttempt,
	type CiLink,
	type CiPromptSource,
	type CiSituation,
	type CiTarget,
	type CiTriageResult,
	isBuiltinId,
	withBuiltins,
} from "./types"

/** One window workspace's board. */
interface CiBoardData {
	targets: CiTarget[]
	/** The conversation last started for each item, by item key. */
	links: Record<string, CiLink>
	/** Auto-watch's attempt counters, so a reload does not reset its caps. */
	autoAttempts: CiAutoAttempt[]
	/** The last triage of each item, without its step details. */
	triage: Record<string, CiTriageResult>
}

interface CiBoardFile {
	version: 2
	boards: Record<string, CiBoardData>
}

const empty = (): CiBoardData => ({ targets: [], links: {}, autoAttempts: [], triage: {} })

/** Attempt counters older than this are dropped. */
const ATTEMPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The boards of every window workspace, in one JSON file under the shared data
 * directory. Like `RecentWorkspacesStore`, it is re-read on every call (each
 * window caches `StateManager` keys at startup, so two windows would overwrite
 * each other's boards there) and written write-then-rename. A board belongs to
 * the window workspace it was made in, so each window polls only its own.
 *
 * Version 1 files (one "Fix CI & conflicts" action and an unused autonomy
 * setting per target) are read and migrated; see `migrateTarget`.
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
			return { version: 2, boards: boards && typeof boards === "object" && !Array.isArray(boards) ? boards : {} }
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				Logger.warn("[CiBoardStore] Failed to read the CI board:", error)
			}
			return { version: 2, boards: {} }
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
	const data = value as { targets?: unknown; links?: unknown; autoAttempts?: unknown; triage?: unknown }
	const targets = Array.isArray(data.targets) ? data.targets.map(migrateTarget).filter((t) => t !== undefined) : []
	const links: Record<string, CiLink> = {}
	if (data.links && typeof data.links === "object") {
		for (const [key, link] of Object.entries(data.links as Record<string, unknown>)) {
			if (link && typeof link === "object" && isString((link as CiLink).conversationId)) {
				links[key] = link as CiLink
			}
		}
	}
	const cutoff = Date.now() - ATTEMPT_RETENTION_MS
	const autoAttempts = Array.isArray(data.autoAttempts)
		? (data.autoAttempts as CiAutoAttempt[]).filter(
				(a) => a && isString(a.key) && typeof a.count === "number" && typeof a.lastTs === "number" && a.lastTs >= cutoff,
			)
		: []
	const triage: Record<string, CiTriageResult> = {}
	if (data.triage && typeof data.triage === "object") {
		for (const [key, result] of Object.entries(data.triage as Record<string, unknown>)) {
			const r = result as CiTriageResult | undefined
			if (r && isString(r.fingerprint) && isString(r.severity) && Array.isArray(r.pipelines)) {
				triage[key] = r
			}
		}
	}
	return { targets, links, autoAttempts, triage }
}

/** A target as saved by either version, or undefined when it is not one. */
function migrateTarget(value: unknown): CiTarget | undefined {
	if (!value || typeof value !== "object") {
		return undefined
	}
	const t = value as Partial<CiTarget> & { autonomy?: unknown; actions?: unknown }
	if (
		!isString(t.id) ||
		!(t.kind === "pr" || t.kind === "branch" || t.kind === "repo") ||
		!isString(t.remoteUrl) ||
		!(t.provider === "github" || t.provider === "ado") ||
		!Array.isArray(t.actions)
	) {
		return undefined
	}
	const actions = (t.actions as unknown[]).map(migrateAction).filter((a) => a !== undefined)
	const { autonomy: _autonomy, ...rest } = t
	return {
		...(rest as CiTarget),
		// Version 1's auto and full-auto never ran anything; auto-watch starts off.
		autoWatch: t.autoWatch === true,
		actions: withBuiltins(actions),
	}
}

const SITUATION_OF_TRIGGER: Record<string, CiSituation> = {
	on_conflict: "conflict",
	on_failure: "failure",
	on_failure_or_conflict: "failure",
	manual: "any",
}

const SITUATIONS: CiSituation[] = ["conflict", "small-delta", "failure", "any"]

function migrateAction(value: unknown): CiAction | undefined {
	const a = value as (Partial<CiAction> & { trigger?: string; prompt?: { kind?: string; id?: string } }) | undefined
	if (!a || !isString(a.id) || !isString(a.label) || !a.prompt || typeof a.prompt !== "object") {
		return undefined
	}
	let prompt: CiPromptSource
	const raw = a.prompt as { kind?: string; id?: string; path?: string; text?: string }
	if (raw.kind === "builtin") {
		if (raw.id && isBuiltinId(raw.id)) {
			prompt = { kind: "builtin", id: raw.id }
		} else if (a.id === "fix" && a.label === "Fix CI & conflicts") {
			// Version 1's untouched default: the built-in actions replace it.
			return undefined
		} else {
			// A renamed version 1 default becomes the Fix CI action with its label.
			return {
				id: "fix-ci",
				label: a.label,
				prompt: { kind: "builtin", id: "fix-ci" },
				model: "free",
				situation: "failure",
				auto: false,
			}
		}
	} else if (raw.kind === "file" && isString(raw.path)) {
		prompt = { kind: "file", path: raw.path }
	} else if (raw.kind === "text" && typeof raw.text === "string") {
		prompt = { kind: "text", text: raw.text }
	} else {
		return undefined
	}
	const situation = SITUATIONS.includes(a.situation as CiSituation)
		? (a.situation as CiSituation)
		: (SITUATION_OF_TRIGGER[a.trigger ?? ""] ?? "any")
	return {
		id: a.id,
		label: a.label,
		prompt,
		model: a.model === "current" ? "current" : "free",
		situation,
		auto: a.auto === true,
	}
}
