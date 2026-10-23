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
import { DEFAULT_MEMORY_TUNING, type MemoryEntry, type MemoryScope, type MemoryTuning, type MemoryType } from "@shared/memory"
import type { GitRunner } from "../context/git-snapshot"
import {
	countImportantEntries,
	editMemoryEntry,
	hasNearDuplicate,
	insertMemoryEntry,
	listMemoryEntries,
	MAX_ENTRY_CHARS,
	MEMORY_FILE_NAME,
	memoryDate,
	memoryFileTemplate,
	normalizeEntryText,
	referencedTopicFiles,
	removeMemoryEntries,
	selectCleanupEntries,
	selectStaleEntries,
	touchMemoryEntries,
} from "./memory-file"
import { looksLikeChangeLog, type MemoryImportanceDemotion, type MemorySaveRejection, readsAsRule } from "./memory-quality"
import { groupIdentity, type RepoIdentity, repoKeyFromIdentity, resolveRepoIdentity } from "./repo-key"

export type { MemoryScope } from "@shared/memory"

const MAX_TOPIC_FILES = 30
const MAX_TOPIC_DETAILS_CHARS = 20_000
const MAX_CACHED_FOLDERS = 50

export interface MemoryLocation {
	group?: string
	groupDir?: string
	groupFile?: string
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
	groupText?: string
	groupTopics?: TopicFile[]
	location: MemoryLocation
	repoText: string
	userText: string
	repoTopics: TopicFile[]
	userTopics: TopicFile[]
}

export interface MemorySaveInput {
	type?: MemoryType
	replace?: boolean
	remove?: boolean
	scope: MemoryScope
	text: string
	importance: "high" | "normal"
	/** A topic file name (`build-quirks`), for `details`. */
	topic?: string
	/** Longer markdown appended to the topic file; the index entry points to it. */
	details?: string
	/**
	 * The conversation saving it, for the per-conversation cap
	 * (MAX_SAVES_PER_CONVERSATION). Without it nothing is counted.
	 */
	conversationId?: string
	/**
	 * The user asked for this exact wording (`/remember`): the change-log gate
	 * and the per-conversation cap do not apply.
	 */
	force?: boolean
}

interface MemorySaveResult {
	removed?: number
	replaced?: boolean
	file: string
	inserted: boolean
	topicFile?: string
	/** The existing entry this memory duplicates; its `used` date was bumped instead. */
	duplicateOf?: string
	/** Why nothing was written: the text reads as a change log, or the conversation saved enough. */
	rejected?: MemorySaveRejection
	/** The entry asked for Important but went under Notes, and why. */
	demoted?: MemoryImportanceDemotion
	/** The importance the entry was saved with. */
	importance: "high" | "normal"
}

/** Something prune proposals offer to remove (docs/memory.md). */
export interface PruneCandidate {
	scope: MemoryScope
	/** The entry as one line, or a description of the topic file. */
	text: string
	/** Set for an orphaned topic file: its name in the scope's folder. */
	topicFile?: string
	/** Why it is offered: not used for 90 days (the default), a change log, or a near duplicate of another entry. */
	reason?: "stale" | "change-log" | "duplicate"
}

/** Entries and topic files proposed for removal per scope, at most. */
const MAX_PRUNE_ENTRIES = 5
const MAX_PRUNE_TOPICS = 3
/** Change-log and duplicate entries proposed for removal per memory and distillation, at most. */
const MAX_CLEANUP_ENTRIES = 8

interface MemoryStoreOptions {
	getTuning?: () => MemoryTuning
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
	readonly tuning: () => MemoryTuning
	private readonly locations = new Map<string, Promise<MemoryLocation>>()
	private readonly writeQueues = new Map<string, Promise<unknown>>()
	/** Entries written per conversation in this window, for the cap. */

	constructor(options: MemoryStoreOptions = {}) {
		this.rootDir = options.rootDir ?? resolveMemoryDataDir()
		this.runGit = options.runGit
		this.now = options.now ?? (() => new Date())
		this.tuning = options.getTuning ?? (() => DEFAULT_MEMORY_TUNING)
	}

	/** Today, as entries record it. */
	private today(): string {
		return memoryDate(this.now())
	}

	/** Where `cwd`'s memory lives. Cached per folder: the repository a folder belongs to rarely changes. */
	locate(cwd: string): Promise<MemoryLocation> {
		let location = this.locations.get(cwd)
		if (!location) {
			location = resolveRepoIdentity(cwd, this.runGit).then(async (repo) => {
				let repoDir = path.join(this.rootDir, "repos", repo.key)
				for (const name of await fs.readdir(path.join(this.rootDir, "repos")).catch(() => [] as string[])) {
					const candidate = path.join(this.rootDir, "repos", name)
					const saved = await this.readJson(path.join(candidate, "repo.json"))
					if (Array.isArray(saved.aliases) && saved.aliases.includes(repo.identity)) {
						repoDir = candidate
						break
					}
				}
				const userDir = path.join(this.rootDir, "user")
				const note = await this.readJson(path.join(repoDir, "repo.json"))
				const group = note.group === false ? undefined : typeof note.group === "string" ? note.group : groupIdentity(repo)
				const groupDir = group ? path.join(this.rootDir, "groups", repoKeyFromIdentity(group)) : undefined
				return {
					group,
					groupDir,
					groupFile: groupDir ? path.join(groupDir, MEMORY_FILE_NAME) : undefined,
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
		const groupText = location.groupFile ? await readText(location.groupFile) : ""
		const groupTopics = location.groupDir ? await this.listTopics(location.groupDir) : []
		return { location, repoText, userText, repoTopics, userTopics, groupText, groupTopics }
	}

	fileFor(location: MemoryLocation, scope: MemoryScope): string {
		const file = scope === "user" ? location.userFile : scope === "group" ? location.groupFile : location.repoFile
		if (!file) throw new Error("This repository has no group. Set group in repo.json to enable it.")
		return file
	}

	private scopeFiles(location: MemoryLocation): [MemoryScope, string][] {
		return [
			["repo", location.repoFile],
			...(location.groupFile ? [["group", location.groupFile] as [MemoryScope, string]] : []),
			["user", location.userFile],
		]
	}

	private async readJson(file: string): Promise<Record<string, unknown>> {
		try {
			const value = JSON.parse(await readText(file))
			return value && typeof value === "object" && !Array.isArray(value) ? value : {}
		} catch {
			return {}
		}
	}

	stateFile(conversationId: string): string {
		return path.join(this.rootDir, "distill", `${conversationId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`)
	}

	async updateState(conversationId: string, patch: Record<string, unknown>): Promise<void> {
		const file = this.stateFile(conversationId)
		await this.serialized(file, async () =>
			writeAtomically(file, JSON.stringify({ ...(await this.readJson(file)), ...patch })),
		)
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

	/**
	 * Adds one memory, creating the files and folders it needs. Every write
	 * path goes through here (the tool, `/remember`, saved proposals), and so
	 * does the gate: a change log is refused, a conversation that has saved
	 * MAX_SAVES_PER_CONVERSATION entries saves no more, and an entry that asks
	 * for Important without reading as a rule, or when Important is full, goes
	 * under Notes. `force` (the user's own wording) skips the refusals.
	 */
	async save(cwd: string, input: MemorySaveInput): Promise<MemorySaveResult> {
		return this.serialized(path.join(this.rootDir, ".mutations"), () => this.saveUnlocked(cwd, input))
	}

	private async saveUnlocked(cwd: string, input: MemorySaveInput): Promise<MemorySaveResult> {
		const location = await this.locate(cwd)
		let file = this.fileFor(location, input.scope)
		// Prefer the existing scope, so a repeated fact does not fill several files.
		for (const [, other] of this.scopeFiles(location)) {
			if (input.remove && other !== file) continue
			if (hasNearDuplicate(await readText(other), input.text)) {
				file = other
				break
			}
		}
		const dir = path.dirname(file)
		const text = normalizeEntryText(input.text)
		const existingEntry = listMemoryEntries(await readText(file), input.scope).find((entry) =>
			hasNearDuplicate(`- ${entry.text}`, text),
		)
		if (input.remove) {
			const scope = this.scopeFiles(location).find(([, candidate]) => candidate === file)?.[0] ?? input.scope
			const removed = existingEntry ? await this.remove(cwd, scope, { texts: [existingEntry.text], topicFiles: [] }) : 0
			return { file, inserted: false, removed, importance: input.importance }
		}
		if (!input.force) {
			if (looksLikeChangeLog(text)) {
				return { file, inserted: false, rejected: "change-log", importance: input.importance }
			}
			const saved = input.conversationId
				? Number((await this.readJson(this.stateFile(input.conversationId))).saveCount ?? 0)
				: 0
			if (!existingEntry && saved >= this.tuning().saveCap) {
				return { file, inserted: false, rejected: "conversation-cap", importance: input.importance }
			}
		}
		let importance = input.importance
		let demoted: MemoryImportanceDemotion | undefined
		if (importance === "high") {
			if (!readsAsRule(text)) {
				demoted = "not-a-rule"
			} else if (!existingEntry && countImportantEntries(await readText(file)) >= this.tuning().importantCap) {
				demoted = "important-full"
			}
			if (demoted) importance = "normal"
		}
		const details = [input.text.length > MAX_ENTRY_CHARS ? input.text : "", input.details?.trim()]
			.filter(Boolean)
			.join("\n\n")
		if (details.length > MAX_TOPIC_DETAILS_CHARS)
			throw new Error(
				`Memory details exceed ${MAX_TOPIC_DETAILS_CHARS} characters; split the explanation into separate memories.`,
			)
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

		if (input.replace && existingEntry) {
			await this.serialized(file, async () => {
				await writeAtomically(
					file,
					editMemoryEntry(await readText(file), existingEntry, {
						text,
						importance,
						type: input.type ?? existingEntry.type,
						topicFile: topicName ?? existingEntry.topicFile,
						used: this.today(),
					}),
				)
			})
			return { file, inserted: false, replaced: true, importance, topicFile: topicPath }
		}

		const result = await this.serialized(file, async () => {
			const title = input.scope === "user" ? "My memory" : `Repository memory: ${location.repo.identity}`
			const existing = await readText(file)
			const insertion = insertMemoryEntry(
				existing,
				{
					text: input.text,
					importance,
					topicFile: topicName,
					date: this.today(),
					type: input.type,
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
		if (result.inserted && input.conversationId && !input.force) {
			const stateFile = this.stateFile(input.conversationId)
			await this.serialized(stateFile, async () => {
				const state = await this.readJson(stateFile)
				await writeAtomically(stateFile, JSON.stringify({ ...state, saveCount: Number(state.saveCount ?? 0) + 1 }))
			})
		}
		return {
			file,
			inserted: result.inserted,
			topicFile: topicPath,
			duplicateOf: result.duplicateOf,
			importance,
			...(demoted && result.inserted ? { demoted } : {}),
		}
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
		for (const [, file] of this.scopeFiles(location)) {
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
		const file = this.fileFor(location, scope)
		const dir = path.dirname(file)
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
		const dir = path.dirname(this.fileFor(location, scope))
		const now = this.now()
		for (const name of names) {
			if (isTopicFileName(name)) {
				await fs.utimes(path.join(dir, name), now, now).catch(() => {})
			}
		}
	}

	/**
	 * What a prune proposal offers to remove: entries that read as a change
	 * log or duplicate another entry (any section, unless pinned or kept
	 * lately), entries not used for STALE_AFTER_DAYS (not under Important,
	 * not pinned, dated), and topic files no entry points to that were not
	 * changed for as long.
	 */
	async pruneCandidates(cwd: string): Promise<PruneCandidate[]> {
		const location = await this.locate(cwd)
		const today = this.today()
		const cutoff = this.now().getTime() - this.tuning().staleDays * 24 * 60 * 60 * 1000
		const candidates: PruneCandidate[] = []
		const broader = `${location.groupFile ? await readText(location.groupFile) : ""}\n${await readText(location.userFile)}`
		for (const [scope, file] of this.scopeFiles(location)) {
			const dir = path.dirname(file)
			const text = await readText(file)
			const cleanup = selectCleanupEntries(text, looksLikeChangeLog, today, MAX_CLEANUP_ENTRIES)
			const other = scope === "repo" ? broader : scope === "group" ? await readText(location.userFile) : ""
			for (const entry of listMemoryEntries(text, scope)) {
				const keptRecently =
					entry.used && Date.parse(today) - Date.parse(entry.used) < this.tuning().staleDays * 24 * 60 * 60 * 1000
				if (
					cleanup.length < MAX_CLEANUP_ENTRIES &&
					!entry.pinned &&
					!keptRecently &&
					hasNearDuplicate(other, entry.text) &&
					!cleanup.some((item) => item.text === entry.text)
				)
					cleanup.push({ text: entry.text, reason: "duplicate" })
			}
			for (const entry of cleanup) {
				candidates.push({ scope, text: entry.text, reason: entry.reason })
			}
			const offered = new Set(cleanup.map((entry) => entry.text))
			const usage = await this.readJson(path.join(dir, "usage.json"))
			const withUsage = listMemoryEntries(text, scope).reduce((content, entry) => {
				const record = usage[entry.id] as { used?: string } | undefined
				return record?.used && record.used > (entry.used ?? entry.added ?? "")
					? touchMemoryEntries(content, [entry.text], record.used).content
					: content
			}, text)
			for (const entry of selectStaleEntries(withUsage, today, this.tuning().staleDays, MAX_PRUNE_ENTRIES)) {
				if (!offered.has(entry.text)) candidates.push({ scope, text: entry.text })
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
		const file = this.fileFor(location, scope)
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
		const file = path.join(location.repoDir, "repo.json")
		const note = {
			...(await this.readJson(file)),
			identity: location.repo.identity,
			kind: location.repo.kind,
			...(location.repo.remoteUrl ? { remote: location.repo.remoteUrl } : {}),
		}
		const content = `${JSON.stringify(note, null, 2)}\n`
		if ((await readText(file)) !== content) {
			await this.serialized(file, () => writeAtomically(file, content))
		}
	}

	async entries(cwd: string): Promise<MemoryEntry[]> {
		const location = await this.locate(cwd)
		const result: MemoryEntry[] = []
		for (const [scope, file] of this.scopeFiles(location)) result.push(...listMemoryEntries(await readText(file), scope))
		return result
	}

	async edit(cwd: string, id: string, patch: Partial<MemoryEntry>): Promise<void> {
		const entry = (await this.entries(cwd)).find((item) => item.id === id)
		if (!entry) throw new Error("Memory changed; refresh and try again.")
		const location = await this.locate(cwd)
		const file = this.fileFor(location, entry.scope)
		await this.serialized(file, async () => writeAtomically(file, editMemoryEntry(await readText(file), entry, patch)))
	}

	async move(cwd: string, id: string, scope: MemoryScope): Promise<void> {
		await this.serialized(path.join(this.rootDir, ".mutations"), async () => {
			const entry = (await this.entries(cwd)).find((item) => item.id === id)
			if (!entry) throw new Error("Memory changed; refresh and try again.")
			if (entry.scope === scope) return
			const location = await this.locate(cwd)
			const source = this.fileFor(location, entry.scope)
			const target = this.fileFor(location, scope)
			// Copy details first, preserving them even when the destination already has this entry.
			let topicFile: string | undefined
			if (entry.topicFile && isTopicFileName(entry.topicFile)) {
				topicFile = `${Date.now()}-${entry.topicFile}`
				await writeAtomically(
					path.join(path.dirname(target), topicFile),
					await fs.readFile(path.join(path.dirname(source), entry.topicFile), "utf8"),
				)
			}
			await this.serialized(target, async () => {
				const existing = await readText(target)
				const duplicate = listMemoryEntries(existing, scope).find((candidate) =>
					hasNearDuplicate(`- ${candidate.text}`, entry.text),
				)
				if (topicFile && duplicate?.topicFile && isTopicFileName(duplicate.topicFile)) {
					const previous = await fs.readFile(path.join(path.dirname(target), duplicate.topicFile), "utf8")
					const copied = await fs.readFile(path.join(path.dirname(target), topicFile), "utf8")
					await writeAtomically(path.join(path.dirname(target), topicFile), `${previous.trimEnd()}\n\n${copied}`)
				}
				let next = insertMemoryEntry(existing, {
					text: entry.text.replace(/ \(details: [^)]+\)$/, ""),
					importance: entry.importance,
					topicFile,
					type: entry.type,
					pinned: entry.pinned,
					date: entry.added ?? this.today(),
				}).content
				const saved = listMemoryEntries(next, scope).find((candidate) =>
					hasNearDuplicate(`- ${candidate.text}`, entry.text),
				)
				if (saved)
					next = editMemoryEntry(next, saved, {
						...(topicFile ? { topicFile } : {}),
						pinned: saved.pinned || entry.pinned,
						used: duplicate ? this.today() : entry.used,
						added: duplicate ? saved.added : (entry.added ?? this.today()),
					})
				await writeAtomically(target, next)
			})
			await this.remove(cwd, entry.scope, { texts: [entry.text], topicFiles: [] })
		})
	}

	async adoptionCandidates(cwd: string): Promise<{ key: string; identity: string }[]> {
		const { repo, repoDir } = await this.locate(cwd)
		if (repo.kind !== "remote") return []
		const result: { key: string; identity: string }[] = []
		for (const key of await fs.readdir(path.join(this.rootDir, "repos")).catch(() => [] as string[])) {
			if (path.join(this.rootDir, "repos", key) === repoDir) continue
			const note = await this.readJson(path.join(this.rootDir, "repos", key, "repo.json"))
			if (
				typeof note.identity === "string" &&
				note.identity !== repo.identity &&
				note.identity.split("/").slice(1).join("/") === repo.identity.split("/").slice(1).join("/")
			)
				result.push({ key, identity: note.identity })
		}
		return result
	}

	async adopt(cwd: string, key: string): Promise<void> {
		if (!(await this.adoptionCandidates(cwd)).some((item) => item.key === key))
			throw new Error("Unknown memory adoption candidate.")
		const location = await this.locate(cwd)
		if (listMemoryEntries(await readText(location.repoFile), "repo").length > 0)
			throw new Error("Repository memory already has entries. Move or export them before adopting another memory.")
		const file = path.join(this.rootDir, "repos", key, "repo.json")
		await this.serialized(file, async () => {
			const note = await this.readJson(file)
			const aliases = Array.isArray(note.aliases) ? note.aliases.filter((value) => typeof value === "string") : []
			await writeAtomically(
				file,
				JSON.stringify({ ...note, aliases: [...new Set([...aliases, location.repo.identity])] }, null, 2),
			)
		})
		this.locations.clear()
	}

	async recordUsage(cwd: string, conversationId: string, entries: readonly MemoryEntry[]): Promise<void> {
		const location = await this.locate(cwd)
		for (const [scope, memoryFile] of this.scopeFiles(location)) {
			const selected = entries.filter((entry) => entry.scope === scope)
			if (!selected.length) continue
			const file = path.join(path.dirname(memoryFile), "usage.json")
			await this.serialized(file, async () => {
				const usage = await this.readJson(file)
				let changed = false
				for (const entry of selected) {
					const previous = usage[entry.id] as { count?: number; conversations?: string[] } | undefined
					const conversations = previous?.conversations ?? []
					if (conversations.includes(conversationId)) continue
					changed = true
					usage[entry.id] = {
						count: (previous?.count ?? 0) + 1,
						used: this.today(),
						conversations: [...conversations, conversationId].slice(-100),
					}
				}
				if (changed) await writeAtomically(file, JSON.stringify(usage))
			})
		}
	}

	async usage(cwd: string): Promise<Record<string, { count?: number; used?: string }>> {
		const location = await this.locate(cwd)
		const all = await Promise.all(
			this.scopeFiles(location).map(([, file]) => this.readJson(path.join(path.dirname(file), "usage.json"))),
		)
		return Object.assign({}, ...all)
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
