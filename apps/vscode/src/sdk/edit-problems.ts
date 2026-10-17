import * as path from "path"
import { Logger } from "@/shared/services/Logger"

/** One error diagnostic, reduced to what the model is told about it. */
export interface EditProblem {
	/** One-based. */
	line: number
	message: string
	source?: string
	code?: string
}

/**
 * What the reporter needs from the editor host. The VS Code implementation is
 * hosts/vscode/edit-diagnostics.ts; tests pass a fake.
 */
export interface EditDiagnosticsSource {
	/** The errors (not warnings or hints) the host currently reports for a file. */
	getErrors(absolutePath: string): EditProblem[]
	/**
	 * The errors the host currently reports for every file on disk, keyed by absolute
	 * path. Virtual documents and files under node_modules, .git or PlinyCode's own
	 * data directories are left out.
	 */
	getAllErrors(): Map<string, EditProblem[]>
	/** Calls the listener with the files whose diagnostics changed, whatever their severity. */
	onDidChangeDiagnostics(listener: (absolutePaths: string[]) => void): { dispose(): void }
	/**
	 * The version of the editor's in-memory copy of the file, which goes up each time
	 * the editor picks up a change; undefined when the editor has not loaded the file.
	 */
	documentVersion(absolutePath: string): number | undefined
	/** Whether the file has an editor tab. */
	isShown(absolutePath: string): boolean
	/**
	 * Gets the host to analyse a file that has no editor tab, without taking the
	 * focus or changing which editor is visible. Resolves to a function that undoes it.
	 */
	showInBackground(absolutePath: string): Promise<() => Promise<void>>
}

export interface EditProblemTimings {
	/** How long to wait for a file's first diagnostics event. */
	firstEventTimeoutMs: number
	/** A file's diagnostics count as settled once no event has arrived for this long. */
	quietPeriodMs: number
	/** Upper bound on the whole wait, whatever the events. */
	maxWaitMs: number
	/** How long after an edit a late diagnostics event is still put down to that edit. */
	lateAnswerWindowMs: number
}

/**
 * VS Code's TypeScript and JSON servers publish about 0.2-0.6 s after a write to a
 * file that has a tab, so the first-event timeout leaves a wide margin, and the cap
 * keeps a cold or busy language server from holding the tool result back.
 */
const DEFAULT_EDIT_PROBLEM_TIMINGS: EditProblemTimings = {
	firstEventTimeoutMs: 1_500,
	quietPeriodMs: 300,
	maxWaitMs: 3_000,
	lateAnswerWindowMs: 60_000,
}

const MAX_PROBLEMS_PER_FILE = 10
/** A patch can touch any number of files; only its first ones are checked. */
const MAX_FILES_PER_EDIT = 10
/** An edit can break any number of importers; the report names the first few. */
const MAX_OTHER_FILES = 5
const MAX_PROBLEMS_PER_OTHER_FILE = 5
/** Type errors can run to many lines; the first part names the problem. */
const MAX_MESSAGE_CHARS = 300
/** Waits with no diagnostics event after which a file extension stops being waited for. */
const SILENT_WAITS_BEFORE_SKIP = 2
const MAX_REMEMBERED_FILES = 200

export interface EditedFile {
	/** The file as it is after the edit. */
	absolutePath: string
	/** How the report names the file when it lists several. */
	displayPath: string
	/** Where the content was before the edit, when the edit moved the file. */
	previousPath?: string
}

interface CheckTarget {
	file: EditedFile
	key: string
	extension: string
	/** Identities of the errors already there before the edit. */
	baseline: string[]
	/** Had a tab before the write, so its diagnostics follow the write with no help. */
	wasShown: boolean
	/** The editor's document version before the write; undefined when it was not loaded. */
	versionBefore: number | undefined
}

/**
 * A file whose live diagnostics cannot serve as the baseline of its next edit:
 * either its last check saw no diagnostics event, so the errors of that edit may
 * still arrive, or this class showed the file and closed it again, after which
 * the host stops analysing it.
 */
interface RememberedFile {
	file: EditedFile
	/** Identities of the errors already reported or there before. */
	accountedFor: string[]
	/** When the check that saw no event ended; undefined once an event confirmed the file. */
	unansweredSince?: number
	/** A diagnostics event arrived for the file soon after that check. */
	answeredLate?: boolean
}

interface ReportSection {
	file: EditedFile
	problems: EditProblem[]
}

/** What a check needs to tell which errors in the files the edit did not touch are new. */
interface OtherFilesContext {
	/** Keys of every edited file, at its new and its old path. */
	editedKeys: Set<string>
	/**
	 * Per file key, the identities of the errors there before the write; undefined
	 * when they could not be read, in which case other files are not reported on.
	 */
	othersBefore: Map<string, string[]> | undefined
	/** The directory the report's paths are relative to. */
	cwd: string | undefined
}

/** Tracks one edit from just before its write until its result is returned. */
export interface EditProblemCheck {
	/** Call as soon as the write has finished; diagnostics events count from here. */
	written(): void
	/**
	 * Waits for the edited files' diagnostics to settle and returns the text to
	 * append to the tool result, or "" when there is nothing to report. Never throws.
	 */
	report(signal?: AbortSignal): Promise<string>
	/** Stops listening. Safe to call at any point, more than once. */
	dispose(): void
}

interface EditProblemsReporterOptions {
	source: EditDiagnosticsSource
	isEnabled: () => boolean
	timings?: Partial<EditProblemTimings>
}

/**
 * Finds the errors an edit introduced: it records a file's errors before the write,
 * waits for the language server to catch up after it, and reports the errors that
 * were not there before. The errors of every other file in the window are recorded
 * too, so that an edit that breaks other files (a renamed export, say) is told
 * about the importers the language server has re-checked by the time the edited
 * files have settled; nothing is waited for on their account.
 *
 * The wait is driven by diagnostics events, and silence is ambiguous: a file type
 * with no language server never produces one, but neither does a server that finds
 * nothing to change (VS Code's TypeScript server publishes nothing when a file had
 * no problems and still has none), nor one that is still starting. So:
 *
 * - Per file extension, the reporter remembers whether it has ever seen a
 *   diagnostics event. An extension that stayed silent through two waits and has
 *   never produced an event is no longer waited for. An event at any later time
 *   turns the wait back on for good.
 * - A file whose check ended in silence is remembered. If its language server
 *   answers shortly afterwards, the errors are reported with the next edit,
 *   whichever file that edit touches.
 *
 * One reporter serves a window for its lifetime; the memory is per window.
 */
export class EditProblemsReporter {
	private readonly timings: EditProblemTimings
	/** Extensions that produced a diagnostics event at some point; they are always waited for. */
	private readonly liveExtensions = new Set<string>()
	/** Per extension, how many checks waited for a diagnostics event and saw none. */
	private readonly silentWaits = new Map<string, number>()
	private readonly remembered = new Map<string, RememberedFile>()
	private readonly activeChecks = new Set<(keys: string[]) => void>()
	private subscription: { dispose(): void } | undefined

	constructor(private readonly options: EditProblemsReporterOptions) {
		this.timings = { ...DEFAULT_EDIT_PROBLEM_TIMINGS, ...options.timings }
	}

	isEnabled(): boolean {
		try {
			return this.options.isEnabled()
		} catch {
			return false
		}
	}

	/**
	 * Records the files' errors before an edit writes them, and the errors of every
	 * other file. Returns undefined when reporting is off or the diagnostics cannot be
	 * read; the edit proceeds either way. The report names other files relative to
	 * `cwd`, the directory the edit's paths are relative to.
	 */
	begin(files: EditedFile[], cwd?: string): EditProblemCheck | undefined {
		try {
			if (files.length === 0 || !this.isEnabled()) {
				return undefined
			}
			this.subscribe()
			const { source } = this.options
			// Every edited file, not only the ones checked: an error in any of them is not one in another file.
			const editedKeys = new Set(
				files.flatMap((file) => [file.absolutePath, file.previousPath ?? file.absolutePath].map(pathKey)),
			)
			const othersBefore = this.snapshotAllErrors()
			const targets = files.slice(0, MAX_FILES_PER_EDIT).map((file): CheckTarget => {
				const previousPath = file.previousPath ?? file.absolutePath
				return {
					file,
					key: pathKey(file.absolutePath),
					extension: extensionOf(file.absolutePath),
					baseline:
						this.remembered.get(pathKey(previousPath))?.accountedFor ??
						source.getErrors(previousPath).map(identityOf),
					wasShown: source.isShown(file.absolutePath),
					versionBefore: source.documentVersion(file.absolutePath),
				}
			})
			return this.createCheck(targets, { editedKeys, othersBefore, cwd })
		} catch (error) {
			Logger.warn(`[EditProblemsReporter] Failed to read diagnostics before an edit: ${error}`)
			return undefined
		}
	}

	/** The identities of every file's errors, keyed like the reporter keys files; undefined when they cannot be read. */
	private snapshotAllErrors(): Map<string, string[]> | undefined {
		try {
			const result = new Map<string, string[]>()
			for (const [absolutePath, errors] of this.options.source.getAllErrors()) {
				if (errors.length > 0) {
					result.set(pathKey(absolutePath), errors.map(identityOf))
				}
			}
			return result
		} catch (error) {
			Logger.warn(`[EditProblemsReporter] Failed to read the diagnostics of other files before an edit: ${error}`)
			return undefined
		}
	}

	/**
	 * Forgets what earlier edits left: errors still to report late, and the
	 * baselines they were measured against. For a conversation that replaces
	 * another, whose edits are not its own to hear about.
	 */
	forget(): void {
		this.remembered.clear()
	}

	dispose(): void {
		this.subscription?.dispose()
		this.subscription = undefined
		this.activeChecks.clear()
	}

	/**
	 * One subscription for the reporter's lifetime, started with the first edit: an
	 * event that arrives after a check stopped waiting still has to be noticed.
	 */
	private subscribe(): void {
		if (this.subscription) {
			return
		}
		this.subscription = this.options.source.onDidChangeDiagnostics((absolutePaths) => {
			const now = Date.now()
			const keys = absolutePaths.map(pathKey)
			for (const [index, absolutePath] of absolutePaths.entries()) {
				const extension = extensionOf(absolutePath)
				this.liveExtensions.add(extension)
				this.silentWaits.delete(extension)
				const file = this.remembered.get(keys[index])
				if (file?.unansweredSince !== undefined && now - file.unansweredSince <= this.timings.lateAnswerWindowMs) {
					file.answeredLate = true
				}
			}
			for (const notify of this.activeChecks) {
				notify(keys)
			}
		})
	}

	private shouldWaitFor(extension: string): boolean {
		return this.liveExtensions.has(extension) || (this.silentWaits.get(extension) ?? 0) < SILENT_WAITS_BEFORE_SKIP
	}

	private remember(key: string, file: RememberedFile): void {
		this.remembered.delete(key)
		this.remembered.set(key, file)
		if (this.remembered.size > MAX_REMEMBERED_FILES) {
			const oldest = this.remembered.keys().next().value
			if (oldest !== undefined) {
				this.remembered.delete(oldest)
			}
		}
	}

	/** Errors that arrived, after their check had stopped waiting, in files other than the ones being checked now. */
	private takeLateAnswers(currentKeys: Set<string>): ReportSection[] {
		const sections: ReportSection[] = []
		for (const [key, file] of this.remembered) {
			if (!file.answeredLate || currentKeys.has(key)) {
				continue
			}
			// The file's diagnostics are known again, so they are its next baseline.
			this.remembered.delete(key)
			const problems = newProblems(this.options.source.getErrors(file.file.absolutePath), file.accountedFor)
			if (problems.length > 0 && sections.length < MAX_FILES_PER_EDIT) {
				sections.push({ file: file.file, problems })
			}
		}
		return sections
	}

	/**
	 * Errors in files the edit did not touch that were not there before it. Only what
	 * the language servers have published by the time the edited files have settled:
	 * a cold importer the server has not re-checked is not seen. Files already
	 * reported as answered late are left out, so an error is told once.
	 */
	private takeOtherFileProblems(others: OtherFilesContext, lateSections: ReportSection[]): ReportSection[] {
		if (!others.othersBefore) {
			return []
		}
		const excluded = new Set([...others.editedKeys, ...lateSections.map((section) => pathKey(section.file.absolutePath))])
		const sections: ReportSection[] = []
		for (const [absolutePath, errors] of this.options.source.getAllErrors()) {
			const key = pathKey(absolutePath)
			if (excluded.has(key)) {
				continue
			}
			const problems = newProblems(errors, others.othersBefore.get(key) ?? [])
			if (problems.length === 0) {
				continue
			}
			// A file edited earlier whose server was slow hears about these now, not again with its next edit.
			this.remembered.get(key)?.accountedFor.push(...problems.map(identityOf))
			sections.push({ file: { absolutePath, displayPath: displayPathOf(absolutePath, others.cwd) }, problems })
		}
		return sections.sort((a, b) => a.file.displayPath.localeCompare(b.file.displayPath))
	}

	private createCheck(targets: CheckTarget[], others: OtherFilesContext): EditProblemCheck {
		const { source } = this.options
		const lastEventAt = new Map<string, number>()
		let writtenAt: number | undefined
		let onEvent: (() => void) | undefined
		/** The files this check showed in the background, each resolving to how to close it. */
		const openings: Promise<(() => Promise<void>) | undefined>[] = []
		const targetsByKey = new Map(targets.map((target) => [target.key, target]))
		const notify = (keys: string[]) => {
			const now = Date.now()
			for (const key of keys) {
				const target = targetsByKey.get(key)
				if (target && hasCaughtUp(target)) {
					lastEventAt.set(key, now)
				}
			}
			onEvent?.()
		}
		/**
		 * Whether the editor's copy of the file reflects the write. A write to a file
		 * open in a tab is followed, within about 100 ms, by an event that re-publishes
		 * the old diagnostics before the editor has even reloaded the file; the new
		 * ones come only after the reload.
		 */
		const hasCaughtUp = (target: CheckTarget): boolean => {
			if (target.versionBefore === undefined) {
				return true
			}
			const version = source.documentVersion(target.file.absolutePath)
			return version === undefined || version > target.versionBefore
		}
		const dispose = () => {
			this.activeChecks.delete(notify)
			onEvent = undefined
			// Close what was opened, including a tab whose open only settles later.
			// Not awaited: the tool result does not depend on it.
			for (const opening of openings.splice(0)) {
				void opening.then((undo) => undo?.()).catch(() => {})
			}
		}

		/** Waits for the targets' diagnostics; resolves to the targets it had to show itself. */
		const settle = async (signal: AbortSignal | undefined): Promise<Set<CheckTarget>> => {
			const startedAt = Date.now()
			const deadline = startedAt + this.timings.maxWaitMs
			const shownHere = new Set<CheckTarget>()
			const firstEventDueAt = new Map<CheckTarget, number>()
			for (const target of targets) {
				if (!this.shouldWaitFor(target.extension)) {
					continue
				}
				if (target.wasShown) {
					// The host saw the write itself, so its answer may already be in.
					firstEventDueAt.set(target, (writtenAt ?? startedAt) + this.timings.firstEventTimeoutMs)
					continue
				}
				// A language server may only analyse files that have a tab (VS Code's
				// TypeScript and JSON servers do). The caller has shown the file by now
				// unless the edit is headless.
				if (!source.isShown(target.file.absolutePath)) {
					const opening = source.showInBackground(target.file.absolutePath).catch(() => undefined)
					openings.push(opening)
					if (!(await withDeadline(opening, deadline, signal))) {
						continue
					}
					shownHere.add(target)
				}
				firstEventDueAt.set(target, Date.now() + this.timings.firstEventTimeoutMs)
			}
			await new Promise<void>((resolve) => {
				let timer: ReturnType<typeof setTimeout> | undefined
				const finish = () => {
					clearTimeout(timer)
					onEvent = undefined
					signal?.removeEventListener("abort", finish)
					resolve()
				}
				const check = () => {
					clearTimeout(timer)
					let dueAt = 0
					for (const [target, firstDueAt] of firstEventDueAt) {
						const eventAt = lastEventAt.get(target.key)
						dueAt = Math.max(dueAt, eventAt === undefined ? firstDueAt : eventAt + this.timings.quietPeriodMs)
					}
					const remaining = Math.min(dueAt, deadline) - Date.now()
					if (remaining <= 0 || signal?.aborted) {
						finish()
					} else {
						timer = setTimeout(check, remaining)
					}
				}
				onEvent = check
				signal?.addEventListener("abort", finish, { once: true })
				check()
			})
			const now = Date.now()
			const silentExtensions = new Set<string>()
			for (const [target, firstDueAt] of firstEventDueAt) {
				// Only a wait that ran its full course says anything about the extension.
				if (!lastEventAt.has(target.key) && now >= firstDueAt && !signal?.aborted) {
					silentExtensions.add(target.extension)
				}
			}
			for (const extension of silentExtensions) {
				this.silentWaits.set(extension, (this.silentWaits.get(extension) ?? 0) + 1)
			}
			return shownHere
		}

		return {
			written: () => {
				writtenAt = Date.now()
				this.activeChecks.add(notify)
			},
			report: async (signal) => {
				try {
					if (writtenAt === undefined || signal?.aborted) {
						return ""
					}
					const shownHere = await settle(signal)
					if (signal?.aborted) {
						return ""
					}
					const sections: ReportSection[] = []
					for (const target of targets) {
						const after = source.getErrors(target.file.absolutePath)
						const problems = newProblems(after, target.baseline)
						if (!lastEventAt.has(target.key)) {
							this.remember(target.key, {
								file: target.file,
								accountedFor: [...target.baseline, ...problems.map(identityOf)],
								unansweredSince: Date.now(),
							})
						} else if (shownHere.has(target)) {
							this.remember(target.key, { file: target.file, accountedFor: after.map(identityOf) })
						} else {
							this.remembered.delete(target.key)
						}
						if (problems.length > 0) {
							sections.push({ file: target.file, problems })
						}
					}
					const lateSections = this.takeLateAnswers(new Set(targets.map((target) => target.key)))
					const otherSections = this.takeOtherFileProblems(others, lateSections)
					return (
						formatReport(sections, targets.length === 1) +
						formatLateReport(lateSections) +
						formatOtherFilesReport(otherSections)
					)
				} catch (error) {
					Logger.warn(`[EditProblemsReporter] Failed to report new problems after an edit: ${error}`)
					return ""
				} finally {
					dispose()
				}
			},
			dispose,
		}
	}
}

/** Resolves to the promise's value, or to undefined once the deadline passes or the signal aborts. */
function withDeadline<T>(promise: Promise<T>, deadline: number, signal: AbortSignal | undefined): Promise<T | undefined> {
	return new Promise((resolve) => {
		const finish = (value: T | undefined) => {
			clearTimeout(timer)
			signal?.removeEventListener("abort", onAbort)
			resolve(value)
		}
		const onAbort = () => finish(undefined)
		const timer = setTimeout(onAbort, Math.max(0, deadline - Date.now()))
		signal?.addEventListener("abort", onAbort, { once: true })
		promise.then(finish, onAbort)
	})
}

function pathKey(absolutePath: string): string {
	const normalized = path.normalize(absolutePath)
	return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

/** Files with no extension (Makefile, Dockerfile) are told apart by name. */
function extensionOf(absolutePath: string): string {
	return (path.extname(absolutePath) || path.basename(absolutePath)).toLowerCase()
}

/** How the model knows a file: relative to the cwd with forward slashes, or absolute when outside it. */
function displayPathOf(absolutePath: string, cwd: string | undefined): string {
	if (cwd) {
		const relative = path.relative(cwd, absolutePath)
		const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
		if (relative && !outside) {
			return relative.split(path.sep).join("/")
		}
	}
	return absolutePath.split(path.sep).join("/")
}

/** An edit moves the lines below it, so an error is the same error wherever it sits. */
function identityOf(problem: EditProblem): string {
	return `${problem.source ?? ""}\u0000${problem.code ?? ""}\u0000${problem.message}`
}

/** The errors in `after` beyond those already accounted for, counting repeats of one error. */
function newProblems(after: EditProblem[], accountedFor: string[]): EditProblem[] {
	const remaining = new Map<string, number>()
	for (const identity of accountedFor) {
		remaining.set(identity, (remaining.get(identity) ?? 0) + 1)
	}
	const result: EditProblem[] = []
	for (const problem of [...after].sort((a, b) => a.line - b.line)) {
		const identity = identityOf(problem)
		const count = remaining.get(identity) ?? 0
		if (count > 0) {
			remaining.set(identity, count - 1)
		} else {
			result.push(problem)
		}
	}
	return result
}

function formatProblems(problems: EditProblem[], limit = MAX_PROBLEMS_PER_FILE): string[] {
	const lines = problems.slice(0, limit).map((problem) => {
		const message = problem.message.replace(/\s*\r?\n\s*/g, " ").trim()
		const clipped = message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…` : message
		const origin = [problem.source, problem.code].filter(Boolean).join(" ")
		return `- line ${problem.line}: ${clipped}${origin ? ` (${origin})` : ""}`
	})
	if (problems.length > limit) {
		lines.push(`and ${problems.length - limit} more`)
	}
	return lines
}

function formatReport(sections: ReportSection[], singleFile: boolean): string {
	if (sections.length === 0) {
		return ""
	}
	const lines = [
		`New problems reported ${singleFile ? "in this file " : ""}after the edit (fix them if your change caused them):`,
	]
	for (const { file, problems } of sections) {
		if (!singleFile) {
			lines.push(file.displayPath)
		}
		lines.push(...formatProblems(problems))
	}
	return `\n\n${lines.join("\n")}`
}

function formatOtherFilesReport(sections: ReportSection[]): string {
	if (sections.length === 0) {
		return ""
	}
	const lines = ["New problems reported in other files after this edit (fix them if your change caused them):"]
	for (const { file, problems } of sections.slice(0, MAX_OTHER_FILES)) {
		lines.push(file.displayPath, ...formatProblems(problems, MAX_PROBLEMS_PER_OTHER_FILE))
	}
	if (sections.length > MAX_OTHER_FILES) {
		lines.push(`and ${sections.length - MAX_OTHER_FILES} more files`)
	}
	return `\n\n${lines.join("\n")}`
}

function formatLateReport(sections: ReportSection[]): string {
	if (sections.length === 0) {
		return ""
	}
	const lines = ["New problems reported in files you edited earlier (fix them if your changes caused them):"]
	for (const { file, problems } of sections) {
		lines.push(file.displayPath, ...formatProblems(problems))
	}
	return `\n\n${lines.join("\n")}`
}
