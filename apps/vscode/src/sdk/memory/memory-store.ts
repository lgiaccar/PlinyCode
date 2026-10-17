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
import {
	insertMemoryEntry,
	MEMORY_FILE_NAME,
	memoryDate,
	memoryFileTemplate,
	referencedTopicFiles,
	removeMemoryEntries,
	STALE_AFTER_DAYS,
	selectStaleEntries,
	touchMemoryEntries,
} from "./memory-file"
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
	/** The existing entry this memory duplicates; its `used` date was bumped instead. */
	duplicateOf?: string
}

/** Something prune proposals offer to remove (docs/memory.md). */
export interface PruneCandidate {
	scope: MemoryScope
	/** The entry as one line, or a description of the topic file. */
	text: string
	/** Set for an orphaned topic file: its name in the scope's folder. */
	topicFile?: string
}

/** Entries and topic files proposed for removal per scope, at most. */
const MAX_PRUNE_ENTRIES = 5
const MAX_PRUNE_TOPICS = 3

interface MemoryStoreOptions {
	rootDir?: string
	runGit?: GitRunner
	/** Clock for entry dates, for tests. */
	now?: () => Date
}

/** A topic file name as save_memory writes it: no folders, ends in .md, not MEMORY.md. */
function isTopicFileName(name: string): boolean {
	return /^[a-z0-9._-]+\.md$/i.test(name) && name !== MEMORY_FILE_NAME && !name.startsWith(".")
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
	private readonly now: () => Date
	private readonly locations = new Map<string, Promise<MemoryLocation>>()
	private readonly writeQueues = new Map<string, Promise<unknown>>()

	constructor(options: MemoryStoreOptions = {}) {
		this.rootDir = options.rootDir ?? resolveMemoryDataDir()
		this.runGit = options.runGit
		this.now = options.now ?? (() => new Date())
	}

	/** Today, as entries record it. */
	private today(): string {
		return memoryDate(this.now())
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

		const result = await this.serialized(file, async () => {
			const title = input.scope === "user" ? "My memory" : `Repository memory: ${location.repo.identity}`
			const existing = await readText(file)
			const insertion = insertMemoryEntry(
				existing,
				{
					text: input.text,
					importance: input.importance,
					topicFile: topicName,
					date: this.today(),
				},
				title,
			)
			// A duplicate changes the file too: its date is bumped.
			if (insertion.content !== existing) {
				await writeAtomically(file, insertion.content)
			}
			return insertion
		})

		if (input.scope === "repo") {
			await this.writeRepoNote(location).catch(() => {})
		}
		return { file, inserted: result.inserted, topicFile: topicPath, duplicateOf: result.duplicateOf }
	}

	/**
	 * Marks as used today the entries, in both memories, that are near
	 * duplicates of `texts`. Returns how many were marked.
	 */
	async touch(cwd: string, texts: readonly string[]): Promise<number> {
		if (texts.length === 0) {
			return 0
		}
		const location = await this.locate(cwd)
		let touched = 0
		for (const file of [location.repoFile, location.userFile]) {
			touched += await this.serialized(file, async () => {
				const existing = await readText(file)
				if (!existing) return 0
				const result = touchMemoryEntries(existing, texts, this.today())
				if (result.touched > 0) await writeAtomically(file, result.content)
				return result.touched
			})
		}
		return touched
	}

	/**
	 * Removes entries (exact text, as proposed) and topic files from one
	 * memory, after the user approved it. A topic file only the removed
	 * entries pointed to goes with them. Returns how many proposed entries and
	 * files were removed.
	 */
	async remove(
		cwd: string,
		scope: MemoryScope,
		items: { texts: readonly string[]; topicFiles: readonly string[] },
	): Promise<number> {
		const location = await this.locate(cwd)
		const dir = scope === "user" ? location.userDir : location.repoDir
		const file = scope === "user" ? location.userFile : location.repoFile
		let removed = 0
		const orphaned: string[] = []
		if (items.texts.length > 0) {
			removed += await this.serialized(file, async () => {
				const existing = await readText(file)
				const result = removeMemoryEntries(existing, items.texts)
				if (result.removed > 0) await writeAtomically(file, result.content)
				orphaned.push(...result.orphanedTopicFiles)
				return result.removed
			})
		}
		const referenced = referencedTopicFiles(await readText(file))
		for (const name of new Set([...orphaned, ...items.topicFiles])) {
			if (!isTopicFileName(name) || referenced.has(name)) continue
			const deleted = await fs
				.rm(path.join(dir, name))
				.then(() => true)
				.catch(() => false)
			// A file that went with its entry is not counted again.
			if (deleted && items.topicFiles.includes(name)) removed++
		}
		return removed
	}

	/** Keeps orphaned topic files out of prune proposals for another STALE_AFTER_DAYS. */
	async keepTopicFiles(cwd: string, scope: MemoryScope, names: readonly string[]): Promise<void> {
		const location = await this.locate(cwd)
		const dir = scope === "user" ? location.userDir : location.repoDir
		const now = this.now()
		for (const name of names) {
			if (isTopicFileName(name)) {
				await fs.utimes(path.join(dir, name), now, now).catch(() => {})
			}
		}
	}

	/**
	 * What a prune proposal offers to remove: entries not used for
	 * STALE_AFTER_DAYS (not under Important, not pinned, dated), and topic
	 * files no entry points to that were not changed for as long.
	 */
	async pruneCandidates(cwd: string): Promise<PruneCandidate[]> {
		const location = await this.locate(cwd)
		const today = this.today()
		const cutoff = this.now().getTime() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000
		const candidates: PruneCandidate[] = []
		for (const scope of ["repo", "user"] as const) {
			const file = scope === "user" ? location.userFile : location.repoFile
			const dir = scope === "user" ? location.userDir : location.repoDir
			const text = await readText(file)
			for (const entry of selectStaleEntries(text, today, STALE_AFTER_DAYS, MAX_PRUNE_ENTRIES)) {
				candidates.push({ scope, text: entry.text })
			}
			const referenced = referencedTopicFiles(text)
			let topics = 0
			for (const topic of await this.listTopics(dir)) {
				const name = path.basename(topic.path)
				if (topics >= MAX_PRUNE_TOPICS) break
				if (referenced.has(name) || !isTopicFileName(name)) continue
				const modified = await fs
					.stat(topic.path)
					.then((stat) => stat.mtimeMs)
					.catch(() => Number.POSITIVE_INFINITY)
				if (modified > cutoff) continue
				candidates.push({
					scope,
					text: `Topic file ${name}${topic.summary ? ` (${topic.summary})` : ""}: no entry points to it`,
					topicFile: name,
				})
				topics++
			}
		}
		return candidates
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
