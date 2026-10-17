/**
 * Commands that outlive the tool call that started them.
 *
 * Two kinds end up here: a terminal command `run_commands` stopped waiting for
 * (after five minutes, "Proceed While Running", or a steering message), which
 * keeps running in its PlinyCode terminal and writes the rest of its output to
 * a log file; and a command started with `run_commands({ background: true })`,
 * which runs as a child process of the extension host from the start. Either
 * way the model gets a short id (`p1`, `p2`, …) and reads the log with
 * `process_output` or stops it with `process_kill` (process-tools.ts).
 *
 * One registry per extension host, owned by SdkController so it outlives
 * session rebuilds. It is in memory only: after a window reload the terminals
 * are gone (they are transient) and so is the list, while the log files stay
 * in the temp folder until its periodic cleanup.
 *
 * No `vscode` import: whoever registers a process supplies the `kill` that
 * knows how to stop it.
 */

export type BackgroundProcessStatus = "running" | "exited" | "killed" | "lost"

export type BackgroundProcessSource = "terminal" | "child"

export interface BackgroundProcess {
	/** Short id the model uses: p1, p2, … unique per extension host. */
	readonly id: string
	/** The conversation (task / root session id) that started it. */
	readonly conversationId: string
	readonly command: string
	readonly cwd: string
	readonly startedAt: number
	readonly source: BackgroundProcessSource
	/** The file that receives the command's output. */
	readonly logPath: string
	readonly status: BackgroundProcessStatus
	/** Set when the command ended with a known exit code. */
	readonly exitCode?: number
	readonly endedAt?: number
	/** Stop it. Resolves once the stop has been attempted; the status says how it went. */
	kill(): Promise<void>
}

interface BackgroundProcessRegistration {
	conversationId: string
	command: string
	cwd: string
	source: BackgroundProcessSource
	logPath: string
	/**
	 * Stops the command. It should report the end through `markExited` when it
	 * sees one; whatever is still running when it resolves is marked killed.
	 */
	kill: () => Promise<void>
}

interface Entry {
	id: string
	conversationId: string
	command: string
	cwd: string
	startedAt: number
	source: BackgroundProcessSource
	logPath: string
	status: BackgroundProcessStatus
	exitCode?: number
	endedAt?: number
	killRequested: boolean
	killing?: Promise<void>
	stop: () => Promise<void>
}

/** Ended processes kept for `process_list`, oldest dropped first. */
const MAX_ENDED_PROCESSES = 50

export class ProcessRegistry {
	private readonly entries = new Map<string, Entry>()
	private readonly listeners = new Set<() => void>()
	private nextId = 1

	constructor(private readonly now: () => number = () => Date.now()) {}

	register(registration: BackgroundProcessRegistration): BackgroundProcess {
		const entry: Entry = {
			id: `p${this.nextId++}`,
			conversationId: registration.conversationId,
			command: registration.command,
			cwd: registration.cwd,
			startedAt: this.now(),
			source: registration.source,
			logPath: registration.logPath,
			status: "running",
			killRequested: false,
			stop: registration.kill,
		}
		this.entries.set(entry.id, entry)
		this.pruneEnded()
		this.fireChange()
		return this.view(entry)
	}

	/** Processes of one conversation, or all of them, oldest first. */
	list(conversationId?: string): BackgroundProcess[] {
		return [...this.entries.values()]
			.filter((entry) => conversationId === undefined || entry.conversationId === conversationId)
			.map((entry) => this.view(entry))
	}

	get(id: string): BackgroundProcess | undefined {
		const entry = this.entries.get(id.trim().toLowerCase())
		return entry ? this.view(entry) : undefined
	}

	/** Whether a process of this conversation (or any, without one) is still running. */
	hasRunning(conversationId?: string): boolean {
		return this.list(conversationId).some((process) => process.status === "running")
	}

	/** The command ended. After a kill was asked for, it counts as killed. */
	markExited(id: string, exitCode?: number): void {
		const entry = this.entries.get(id)
		if (!entry || entry.status !== "running") {
			return
		}
		entry.status = entry.killRequested ? "killed" : "exited"
		entry.exitCode = exitCode
		entry.endedAt = this.now()
		this.fireChange()
	}

	/** PlinyCode can no longer see the command: it may or may not still be running. */
	markLost(id: string): void {
		const entry = this.entries.get(id)
		if (!entry || entry.status !== "running") {
			return
		}
		entry.status = entry.killRequested ? "killed" : "lost"
		entry.endedAt = this.now()
		this.fireChange()
	}

	/** Stop one process. A second call while the first is in progress waits for it. */
	async kill(id: string): Promise<BackgroundProcess | undefined> {
		const entry = this.entries.get(id.trim().toLowerCase())
		if (!entry) {
			return undefined
		}
		if (entry.status === "running") {
			if (!entry.killing) {
				entry.killRequested = true
				entry.killing = entry
					.stop()
					.catch(() => {
						// The status below records that it is still running, if it is.
					})
					.finally(() => {
						if (entry.status === "running") {
							entry.status = "killed"
							entry.endedAt = this.now()
							this.fireChange()
						}
					})
			}
			await entry.killing
		}
		return this.view(entry)
	}

	/** Stop every running process of a conversation, or of all conversations. Returns how many. */
	async killAll(conversationId?: string, filter?: (process: BackgroundProcess) => boolean): Promise<number> {
		const running = this.list(conversationId).filter((process) => process.status === "running" && (filter?.(process) ?? true))
		await Promise.all(running.map((process) => this.kill(process.id)))
		return running.length
	}

	/** Called whenever a process is added or changes status. Returns a disposer. */
	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener)
		return { dispose: () => this.listeners.delete(listener) }
	}

	private view(entry: Entry): BackgroundProcess {
		return {
			id: entry.id,
			conversationId: entry.conversationId,
			command: entry.command,
			cwd: entry.cwd,
			startedAt: entry.startedAt,
			source: entry.source,
			logPath: entry.logPath,
			status: entry.status,
			exitCode: entry.exitCode,
			endedAt: entry.endedAt,
			kill: async () => {
				await this.kill(entry.id)
			},
		}
	}

	private pruneEnded(): void {
		const ended = [...this.entries.values()].filter((entry) => entry.status !== "running")
		for (const entry of ended.slice(0, Math.max(0, ended.length - MAX_ENDED_PROCESSES))) {
			this.entries.delete(entry.id)
		}
	}

	private fireChange(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener()
			} catch {
				// A listener's failure must not stop the others or the caller.
			}
		}
	}
}
