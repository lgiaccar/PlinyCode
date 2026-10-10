// Reads and writes the memory files (docs/memory.md):
//
//   <memory dir>/user/MEMORY.md                 the user's own, every repository
//   <memory dir>/repos/<repo key>/MEMORY.md     one repository's, always loaded
//   <memory dir>/repos/<repo key>/<topic>.md    detail, read on demand
//   <memory dir>/repos/<repo key>/repo.json     which repository the key is
//
// Every write goes through `serialized`, one at a time per file in this
// window, holding `<file>.lock` against other windows (withFileLock), and
// lands with a rename, so two windows saving at once neither lose an entry
// nor leave half a file.

import { promises as fs } from "node:fs"
import * as path from "node:path"
import { resolveMemoryDataDir } from "@plinycode/shared/storage"
import type { GitRunner } from "../context/git-snapshot"
import { insertMemoryEntry, MEMORY_FILE_NAME, memoryFileTemplate } from "./memory-file"
import { type RepoIdentity, resolveRepoIdentity } from "./repo-key"

export type MemoryScope = "repo" | "user"

const MAX_TOPIC_FILES = 30
const MAX_TOPIC_DETAILS_CHARS = 20_000
const MAX_CACHED_FOLDERS = 50

export interface MemoryLocation {
	repo: RepoIdentity
	repoDir: string
	repoFile: string
	userDir: string
	userFile: string
}

export interface TopicFile {
	path: string
	/** The file's first non-empty line, without heading marks. */
	summary: string
}

export interface MemoryContents {
	location: MemoryLocation
	repoText: string
	userText: string
	repoTopics: TopicFile[]
	userTopics: TopicFile[]
}

export interface MemorySaveInput {
	scope: MemoryScope
	text: string
	importance: "high" | "normal"
	/** A topic file name (`build-quirks`), for `details`. */
	topic?: string
	/** Longer markdown appended to the topic file; the index entry points to it. */
	details?: string
}

interface MemorySaveResult {
	file: string
	inserted: boolean
	topicFile?: string
}

interface MemoryStoreOptions {
	rootDir?: string
	runGit?: GitRunner
}

/** `Build quirks!` → `build-quirks`. */
export function topicFileName(topic: string): string | undefined {
	const slug = topic
		.trim()
		.replace(/\.md$/i, "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 60)
	return slug && slug !== "memory" ? `${slug}.md` : undefined
}

async function readText(file: string): Promise<string> {
	try {
		return await fs.readFile(file, "utf8")
	} catch {
		return ""
	}
}

async function writeAtomically(file: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true })
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`
	await fs.writeFile(temp, content, "utf8")
	try {
		await fs.rename(temp, file)
	} catch (error) {
		await fs.rm(temp, { force: true })
		throw error
	}
}

/** How long a write waits for another window's lock before going ahead anyway. */
const LOCK_WAIT_MS = 2_000
/** A lock older than this was left by a window that died mid-write. */
const LOCK_STALE_MS = 10_000
const LOCK_RETRY_MS = 50

/**
 * Runs `task` holding `<file>.lock`, created exclusively, so two VS Code
 * windows do not interleave a read-modify-write of one memory file.
 * Best-effort: a stale lock is broken, and after LOCK_WAIT_MS the write goes
 * ahead without it rather than failing the save.
 */
export async function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
	const lock = `${file}.lock`
	await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {})
	const deadline = Date.now() + LOCK_WAIT_MS
	let held = false
	while (!held) {
		try {
			const handle = await fs.open(lock, "wx")
			await handle.close()
			held = true
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				break
			}
			const age = await fs
				.stat(lock)
				.then((stat) => Date.now() - stat.mtimeMs)
				.catch(() => 0)
			if (age > LOCK_STALE_MS) {
				await fs.rm(lock, { force: true }).catch(() => {})
				continue
			}
			if (Date.now() >= deadline) {
				break
			}
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
		}
	}
	try {
		return await task()
	} finally {
		if (held) {
			await fs.rm(lock, { force: true }).catch(() => {})
		}
	}
}

function firstLine(text: string): string {
	const line = text.split(/\r?\n/).find((candidate) => candidate.trim()) ?? ""
	return line
		.replace(/^\s*#+\s*/, "")
		.trim()
		.slice(0, 120)
}

export class MemoryStore {
	readonly rootDir: string
	private readonly runGit: GitRunner | undefined
	private readonly locations = new Map<string, Promise<MemoryLocation>>()
	private readonly writeQueues = new Map<string, Promise<unknown>>()

	constructor(options: MemoryStoreOptions = {}) {
		this.rootDir = options.rootDir ?? resolveMemoryDataDir()
		this.runGit = options.runGit
	}

	/** Where `cwd`'s memory lives. Cached per folder: the repository a folder belongs to rarely changes. */
	locate(cwd: string): Promise<MemoryLocation> {
		let location = this.locations.get(cwd)
		if (!location) {
			location = resolveRepoIdentity(cwd, this.runGit).then((repo) => {
				const repoDir = path.join(this.rootDir, "repos", repo.key)
				const userDir = path.join(this.rootDir, "user")
				return {
					repo,
					repoDir,
					repoFile: path.join(repoDir, MEMORY_FILE_NAME),
					userDir,
					userFile: path.join(userDir, MEMORY_FILE_NAME),
				}
			})
			this.locations.set(cwd, location)
			if (this.locations.size > MAX_CACHED_FOLDERS) {
				const oldest = this.locations.keys().next().value
				if (oldest !== undefined) this.locations.delete(oldest)
			}
		}
		return location
	}

	async read(cwd: string): Promise<MemoryContents> {
		const location = await this.locate(cwd)
		const [repoText, userText, repoTopics, userTopics] = await Promise.all([
			readText(location.repoFile),
			readText(location.userFile),
			this.listTopics(location.repoDir),
			this.listTopics(location.userDir),
		])
		return { location, repoText, userText, repoTopics, userTopics }
	}

	async listTopics(dir: string): Promise<TopicFile[]> {
		let names: string[]
		try {
			names = await fs.readdir(dir)
		} catch {
			return []
		}
		const topics = names
			.filter((name) => name.toLowerCase().endsWith(".md") && name !== MEMORY_FILE_NAME)
			.sort()
			.slice(0, MAX_TOPIC_FILES)
		return Promise.all(
			topics.map(async (name) => {
				const file = path.join(dir, name)
				return { path: file, summary: firstLine(await readText(file)) }
			}),
		)
	}

	/** Adds one memory, creating the files and folders it needs. */
	async save(cwd: string, input: MemorySaveInput): Promise<MemorySaveResult> {
		const location = await this.locate(cwd)
		const dir = input.scope === "user" ? location.userDir : location.repoDir
		const file = input.scope === "user" ? location.userFile : location.repoFile
		const details = input.details?.trim()
		const topicName = details ? topicFileName(input.topic || input.text.split(/\s+/).slice(0, 4).join(" ")) : undefined
		const topicPath = topicName ? path.join(dir, topicName) : undefined

		if (topicPath && details) {
			await this.serialized(topicPath, async () => {
				const existing = await readText(topicPath)
				const heading = existing.trim() ? "" : `# ${input.topic?.trim() || topicName?.replace(/\.md$/, "")}\n\n`
				const body = details.length > MAX_TOPIC_DETAILS_CHARS ? `${details.slice(0, MAX_TOPIC_DETAILS_CHARS)}…` : details
				const next = `${existing.replace(/\s+$/, "")}${existing.trim() ? "\n\n" : heading}${body}\n`
				await writeAtomically(topicPath, next)
			})
		}

		const inserted = await this.serialized(file, async () => {
			const title = input.scope === "user" ? "My memory" : `Repository memory: ${location.repo.identity}`
			const result = insertMemoryEntry(
				await readText(file),
				{
					text: input.text,
					importance: input.importance,
					topicFile: topicName,
				},
				title,
			)
			if (result.inserted) {
				await writeAtomically(file, result.content)
			}
			return result.inserted
		})

		if (input.scope === "repo") {
			await this.writeRepoNote(location).catch(() => {})
		}
		return { file, inserted, topicFile: topicPath }
	}

	/** The memory file of a scope, created from the template when it does not exist yet. */
	async ensureFile(cwd: string, scope: MemoryScope): Promise<string> {
		const location = await this.locate(cwd)
		const file = scope === "user" ? location.userFile : location.repoFile
		await this.serialized(file, async () => {
			if (!(await readText(file))) {
				const title = scope === "user" ? "My memory" : `Repository memory: ${location.repo.identity}`
				await writeAtomically(file, memoryFileTemplate(title))
			}
		})
		if (scope === "repo") {
			await this.writeRepoNote(location).catch(() => {})
		}
		return file
	}

	/** `repo.json` says which repository a `repos/<key>` folder belongs to, for whoever browses the folder. */
	private async writeRepoNote(location: MemoryLocation): Promise<void> {
		const note = {
			identity: location.repo.identity,
			kind: location.repo.kind,
			...(location.repo.remoteUrl ? { remote: location.repo.remoteUrl } : {}),
		}
		const file = path.join(location.repoDir, "repo.json")
		const content = `${JSON.stringify(note, null, 2)}\n`
		if ((await readText(file)) !== content) {
			await this.serialized(file, () => writeAtomically(file, content))
		}
	}

	private serialized<T>(file: string, task: () => Promise<T>): Promise<T> {
		const previous = this.writeQueues.get(file) ?? Promise.resolve()
		// The queue orders this window's writes; the lock file orders them with
		// another window's, whose read-modify-write would otherwise overwrite
		// an entry saved in between. Each task reads the file inside the lock.
		const next = previous.catch(() => {}).then(() => withFileLock(file, task))
		this.writeQueues.set(file, next)
		const forget = () => {
			if (this.writeQueues.get(file) === next) {
				this.writeQueues.delete(file)
			}
		}
		next.then(forget, forget)
		return next
	}
}
