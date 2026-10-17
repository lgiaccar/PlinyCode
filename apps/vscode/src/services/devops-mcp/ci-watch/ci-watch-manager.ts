/**
 * The CI watches of this window: at most one per conversation. When a watch
 * ends, its report is sent into the conversation through the
 * `CiWatchConversationHost`, which knows whether the conversation is on screen,
 * mid-turn or not loaded. With a `store`, the watches, wake-up counts and
 * reports not sent yet are saved on every change and `restore` carries them on
 * after a window reload. No `vscode` import, so the SDK session code can
 * depend on it.
 */
import { Logger } from "@/shared/services/Logger"
import { buildCiWatchMessage, type CiWatchMessage } from "./ci-watch-report"
import type { CiWatchTargetSpec } from "./ci-watch-source"
import type { CiWatchPersistence, CiWatchRecord, CiWatchSavedWatch } from "./ci-watch-store"
import {
	type CiWatchClock,
	CiWatcher,
	type CiWatcherState,
	type CiWatchOutcome,
	type CiWatchSource,
	type CiWatchTimings,
	type CiWatchUntil,
	DEFAULT_CI_WATCH_TIMINGS,
	SYSTEM_CLOCK,
} from "./ci-watcher"

/**
 * What became of a report: it started a turn, it waits for the running turn to
 * end, the conversation is between states (try again shortly), or the
 * conversation is not loaded in this window.
 */
export type CiWatchDelivery = "started" | "queued" | "busy" | "unavailable"

export interface CiWatchConversationHost {
	/** Sends a report into the conversation as a prompt. */
	deliver(conversationId: string, prompt: string): Promise<CiWatchDelivery>
	/** Shows a line in the chat if the conversation is the one on screen. */
	showRow(conversationId: string, text: string): void
	/** Shows a notification with an action that opens the conversation. */
	notify(conversationId: string, message: string): void
}

export interface CiWatchRequest {
	source: CiWatchSource
	/** What is watched, e.g. "PR #12 (feature → main)". */
	label: string
	/** "GitHub" or "Azure DevOps". */
	providerKind: string
	/** The head commit at registration. */
	head: string
	until: CiWatchUntil
	/** How to rebuild `source` after a reload. A watch without it is not saved. */
	target?: CiWatchTargetSpec
}

/** What `restore` needs from the controller and the DevOps service. */
export interface CiWatchRestoreOptions {
	/** Whether the conversation is still in the task history. */
	exists(conversationId: string): Promise<boolean>
	/** Rebuilds a saved watch's source; `head` is the last head it saw. */
	openSource(target: CiWatchTargetSpec, head: string): Promise<CiWatchSource>
}

interface CiWatchManagerOptions {
	clock?: CiWatchClock
	timings?: CiWatchTimings
	/** Reports a conversation may receive in a row without a message from the user. */
	maxWakeUps?: number
	/** How long to wait before sending again to a conversation that was busy. */
	retryMs?: number
	maxRetries?: number
	/** Where the watches are saved. Without one they live in memory only. */
	store?: CiWatchPersistence
}

interface ActiveWatch {
	request: CiWatchRequest
	watcher: CiWatcher
}

/**
 * A fix → push → watch cycle wakes the conversation by itself, so without a
 * limit it could run unattended for as long as CI keeps failing.
 */
const MAX_WAKE_UPS = 5
const RETRY_MS = 10_000
const MAX_RETRIES = 30

const short = (commit: string) => commit.slice(0, 8)

/** How the watcher signs its lines in the chat. */
const ciWatchRow = (text: string) => `**CI watcher** · ${text}`

/**
 * A source that is built when the watch first polls. A restored watch starts
 * before the DevOps service may be ready, and a source that cannot be built
 * fails that poll like an API error would, so the watch reports it in the end.
 */
function lazySource(open: () => Promise<CiWatchSource>): CiWatchSource {
	let pending: Promise<CiWatchSource> | undefined
	const source = () => {
		pending ??= open().catch((error) => {
			pending = undefined
			throw error
		})
		return pending
	}
	return {
		head: async () => (await source()).head(),
		runs: async (head) => (await source()).runs(head),
		report: async (runId) => (await source()).report(runId),
	}
}

export class CiWatchManager {
	private readonly watches = new Map<string, ActiveWatch>()
	/** Reports sent to each conversation since the user last wrote in it. */
	private readonly wakeUps = new Map<string, number>()
	/** Reports for conversations that are not loaded, sent when they are opened. */
	private readonly held = new Map<string, CiWatchMessage>()
	/** Reports on their way, or waiting to try again; saved as held so a reload does not lose them. */
	private readonly outgoing = new Map<string, CiWatchMessage>()
	private readonly retries = new Map<string, unknown>()
	/** The latest send per conversation; an older one that is still on its way gives way to it. */
	private readonly sending = new Map<string, object>()
	private readonly clock: CiWatchClock
	private readonly timings: CiWatchTimings
	private readonly maxWakeUps: number
	private readonly retryMs: number
	private readonly maxRetries: number
	private readonly store?: CiWatchPersistence
	private saving: Promise<void> = Promise.resolve()
	private saveQueued = false
	/** Saving waits while `restore` reads the file, so it cannot overwrite what is not restored yet. */
	private restoring = false
	/** Bumped by `clear` and `dispose`, which a `restore` still running must not undo. */
	private epoch = 0
	private disposed = false

	constructor(
		private readonly host: CiWatchConversationHost,
		options: CiWatchManagerOptions = {},
	) {
		this.clock = options.clock ?? SYSTEM_CLOCK
		this.timings = options.timings ?? DEFAULT_CI_WATCH_TIMINGS
		this.maxWakeUps = options.maxWakeUps ?? MAX_WAKE_UPS
		this.retryMs = options.retryMs ?? RETRY_MS
		this.maxRetries = options.maxRetries ?? MAX_RETRIES
		this.store = options.store
	}

	/** What the conversation is watching, if anything. */
	watching(conversationId: string): string | undefined {
		return this.watches.get(conversationId)?.request.label
	}

	/** Starts a watch, replacing the conversation's previous one. Returns the label of the replaced watch. */
	watch(conversationId: string, request: CiWatchRequest): string | undefined {
		const replaced = this.stop(conversationId)
		this.start(conversationId, request)
		this.persist()
		Logger.log(`[CiWatch] ${conversationId}: watching ${request.label} at ${short(request.head)} until ${request.until}`)
		const until = request.until === "first_failure" ? "until a run fails or all of them finish" : "until its runs finish"
		const instead = replaced ? ` This replaces the watch on ${replaced}.` : ""
		this.host.showRow(
			conversationId,
			ciWatchRow(
				`Watching CI for ${request.label} at \`${short(request.head)}\` ${until}. The result will arrive here as a message.${instead}`,
			),
		)
		return replaced
	}

	/** Stops the conversation's watch. Returns its label, or undefined when there was none. */
	cancel(conversationId: string): string | undefined {
		const label = this.stop(conversationId)
		if (label) {
			this.persist()
			Logger.log(`[CiWatch] ${conversationId}: stopped watching ${label}`)
			this.host.showRow(conversationId, ciWatchRow(`Stopped watching CI for ${label}.`))
		}
		return label
	}

	/** The user wrote in the conversation, so it is attended again. */
	noteUserMessage(conversationId: string): void {
		if (this.wakeUps.delete(conversationId)) {
			this.persist()
		}
	}

	/** The conversation was opened: send it the report that was waiting for that. */
	conversationOpened(conversationId: string): void {
		const message = this.held.get(conversationId)
		if (message) {
			this.held.delete(conversationId)
			void this.send(conversationId, message, { announce: false })
		}
	}

	/** Forgets everything about a conversation, e.g. because it was deleted. */
	removeConversation(conversationId: string): void {
		this.stop(conversationId)
		this.clearRetry(conversationId)
		this.sending.delete(conversationId)
		this.held.delete(conversationId)
		this.outgoing.delete(conversationId)
		this.wakeUps.delete(conversationId)
		this.persist()
	}

	/** Stops every watch and drops every report that was not sent yet, also from the store. */
	clear(): void {
		this.epoch++
		const known = [this.watches, this.retries, this.sending, this.held, this.outgoing, this.wakeUps].flatMap((map) => [
			...map.keys(),
		])
		for (const conversationId of new Set(known)) {
			this.removeConversation(conversationId)
		}
		this.persist()
	}

	/**
	 * Stops polling and sending, because the window is closing or reloading.
	 * Unlike `clear`, it keeps what is saved, for the next window to restore.
	 */
	dispose(): void {
		this.disposed = true
		this.epoch++
		for (const watch of this.watches.values()) {
			watch.watcher.cancel()
		}
		for (const conversationId of [...this.retries.keys()]) {
			this.clearRetry(conversationId)
		}
	}

	/**
	 * Carries on the watches the store holds from before a reload: those of
	 * conversations that no longer exist are dropped, as are watches past their
	 * deadline (without a report: their result is out of date). Wake-up counts
	 * and held reports come back as they were; a held report is sent when its
	 * conversation is opened.
	 */
	async restore(options: CiWatchRestoreOptions): Promise<void> {
		if (!this.store || this.disposed) {
			return
		}
		const epoch = this.epoch
		this.restoring = true
		try {
			const records = await this.store.load()
			let resumed = 0
			let dropped = 0
			for (const record of records) {
				const exists = await options.exists(record.conversationId).catch((error) => {
					// Keep what cannot be checked rather than lose it.
					Logger.warn(`[CiWatch] Could not check conversation ${record.conversationId}: ${error}`)
					return true
				})
				if (epoch !== this.epoch) {
					return
				}
				if (!exists) {
					dropped++
					continue
				}
				if (this.restoreRecord(record, options)) {
					resumed++
				}
			}
			if (records.length > 0) {
				Logger.log(`[CiWatch] Resumed ${resumed} watch(es); dropped the records of ${dropped} deleted conversation(s)`)
			}
		} catch (error) {
			Logger.warn(`[CiWatch] Could not restore the CI watches: ${error}`)
		} finally {
			this.restoring = false
			// Writes back what was kept: deleted conversations and expired watches leave the file.
			this.persist()
		}
	}

	/** Applies one saved record; true when it resumed a watch. */
	private restoreRecord(record: CiWatchRecord, options: CiWatchRestoreOptions): boolean {
		const id = record.conversationId
		if ([this.watches, this.held, this.outgoing, this.wakeUps].some((map) => map.has(id))) {
			// The conversation did something in this window while the file was read; that wins.
			return false
		}
		if (record.wakeUps) {
			this.wakeUps.set(id, record.wakeUps)
		}
		if (record.held) {
			this.held.set(id, record.held)
		}
		const saved = record.watch
		if (!saved) {
			return false
		}
		if (this.clock.now() >= saved.deadline) {
			Logger.log(`[CiWatch] ${id}: dropped the watch on ${saved.label}, which ran out of time during the reload`)
			return false
		}
		this.start(
			id,
			{
				source: lazySource(() => options.openSource(saved.target, saved.head)),
				label: saved.label,
				providerKind: saved.providerKind,
				head: saved.head,
				until: saved.until,
				target: saved.target,
			},
			{ startedAt: saved.startedAt, headSince: saved.headSince, headMoves: saved.headMoves },
		)
		Logger.log(`[CiWatch] ${id}: resumed watching ${saved.label} at ${short(saved.head)}`)
		return true
	}

	private start(conversationId: string, request: CiWatchRequest, resume?: Omit<CiWatcherState, "head">): void {
		const watch: ActiveWatch = {
			request,
			watcher: new CiWatcher({
				source: request.source,
				head: request.head,
				until: request.until,
				clock: this.clock,
				timings: this.timings,
				resume,
				onHeadMove: () => this.persist(),
				onOutcome: (outcome) => this.handleOutcome(conversationId, watch, outcome),
			}),
		}
		this.watches.set(conversationId, watch)
	}

	private stop(conversationId: string): string | undefined {
		const watch = this.watches.get(conversationId)
		watch?.watcher.cancel()
		this.watches.delete(conversationId)
		return watch?.request.label
	}

	private clearRetry(conversationId: string): void {
		this.clock.clearTimeout(this.retries.get(conversationId))
		this.retries.delete(conversationId)
	}

	/** Saves the current state, once for any number of changes made before the save runs. */
	private persist(): void {
		const store = this.store
		if (!store || this.disposed || this.restoring || this.saveQueued) {
			return
		}
		this.saveQueued = true
		this.saving = this.saving.then(async () => {
			this.saveQueued = false
			if (this.disposed) {
				return
			}
			try {
				await store.save(this.snapshot())
			} catch (error) {
				Logger.warn(`[CiWatch] Could not save the CI watches: ${error}`)
			}
		})
	}

	private snapshot(): CiWatchRecord[] {
		const ids = new Set([...this.watches.keys(), ...this.wakeUps.keys(), ...this.held.keys(), ...this.outgoing.keys()])
		const records: CiWatchRecord[] = []
		for (const conversationId of ids) {
			const active = this.watches.get(conversationId)
			const watch = active ? this.savedWatch(active) : undefined
			const wakeUps = this.wakeUps.get(conversationId)
			const held = this.held.get(conversationId) ?? this.outgoing.get(conversationId)
			if (watch || wakeUps || held) {
				records.push({
					conversationId,
					...(watch ? { watch } : {}),
					...(wakeUps ? { wakeUps } : {}),
					...(held ? { held } : {}),
				})
			}
		}
		return records
	}

	private savedWatch({ request, watcher }: ActiveWatch): CiWatchSavedWatch | undefined {
		if (!request.target) {
			return undefined
		}
		const state = watcher.state
		return {
			label: request.label,
			providerKind: request.providerKind,
			target: request.target,
			until: request.until,
			...state,
			deadline: state.startedAt + this.timings.maxMs,
		}
	}

	private handleOutcome(conversationId: string, watch: ActiveWatch, outcome: CiWatchOutcome): void {
		if (this.watches.get(conversationId) !== watch) {
			return
		}
		this.watches.delete(conversationId)
		const { request } = watch
		const message = buildCiWatchMessage(request.label, request.providerKind, outcome, this.timings)
		Logger.log(`[CiWatch] ${conversationId}: ${message.headline}`)
		void this.send(conversationId, message, { announce: true })
	}

	/**
	 * @param options.announce notify the user when the conversation is not
	 * loaded. False when the conversation was just opened: the user is looking
	 * at it.
	 */
	private async send(
		conversationId: string,
		message: CiWatchMessage,
		options: { announce: boolean },
		attempt = 0,
	): Promise<void> {
		// A newer report replaces one that is still waiting for its turn.
		this.clearRetry(conversationId)
		this.held.delete(conversationId)
		if ((this.wakeUps.get(conversationId) ?? 0) >= this.maxWakeUps) {
			this.outgoing.delete(conversationId)
			this.persist()
			const why =
				`PlinyCode did not send this result to the agent, because the CI watcher has already woken this conversation ` +
				`${this.maxWakeUps} times in a row without a message from you. Send a message there to let the agent react to CI again.`
			Logger.log(`[CiWatch] ${conversationId}: wake-up limit reached; notifying only`)
			this.host.showRow(conversationId, ciWatchRow(`${message.headline} ${why}`))
			this.host.notify(conversationId, `PlinyCode CI watcher: ${message.headline} ${why}`)
			return
		}
		this.outgoing.set(conversationId, message)
		this.persist()
		const token = {}
		this.sending.set(conversationId, token)
		let delivery: CiWatchDelivery
		try {
			delivery = await this.host.deliver(conversationId, message.prompt)
		} catch (error) {
			Logger.warn(`[CiWatch] ${conversationId}: could not deliver the report: ${error}`)
			delivery = "unavailable"
		}
		if (this.disposed || this.sending.get(conversationId) !== token) {
			// The window is closing, the conversation was deleted, or a newer report took over, while this one was on its way.
			return
		}
		this.sending.delete(conversationId)
		if (delivery === "busy" && attempt < this.maxRetries) {
			this.retries.set(
				conversationId,
				this.clock.setTimeout(() => {
					this.retries.delete(conversationId)
					void this.send(conversationId, message, options, attempt + 1)
				}, this.retryMs),
			)
			return
		}
		this.outgoing.delete(conversationId)
		if (delivery === "started" || delivery === "queued") {
			this.wakeUps.set(conversationId, (this.wakeUps.get(conversationId) ?? 0) + 1)
			this.persist()
			return
		}
		this.held.set(conversationId, message)
		this.persist()
		if (options.announce) {
			this.host.notify(
				conversationId,
				`PlinyCode CI watcher: ${message.headline} Open the conversation to send this result to the agent.`,
			)
		}
	}
}
