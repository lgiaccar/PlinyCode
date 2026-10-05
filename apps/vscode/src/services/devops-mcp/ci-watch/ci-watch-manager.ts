/**
 * The CI watches of this window: at most one per conversation, kept in memory.
 * When a watch ends, its report is sent into the conversation through the
 * `CiWatchConversationHost`, which knows whether the conversation is on screen,
 * mid-turn or not loaded. No `vscode` import, so the SDK session code can
 * depend on it.
 */
import { Logger } from "@/shared/services/Logger"
import { buildCiWatchMessage, type CiWatchMessage } from "./ci-watch-report"
import {
	type CiWatchClock,
	CiWatcher,
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
}

interface CiWatchManagerOptions {
	clock?: CiWatchClock
	timings?: CiWatchTimings
	/** Reports a conversation may receive in a row without a message from the user. */
	maxWakeUps?: number
	/** How long to wait before sending again to a conversation that was busy. */
	retryMs?: number
	maxRetries?: number
}

interface ActiveWatch {
	label: string
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

export class CiWatchManager {
	private readonly watches = new Map<string, ActiveWatch>()
	/** Reports sent to each conversation since the user last wrote in it. */
	private readonly wakeUps = new Map<string, number>()
	/** Reports for conversations that are not loaded, sent when they are opened. */
	private readonly held = new Map<string, CiWatchMessage>()
	private readonly retries = new Map<string, unknown>()
	/** The latest send per conversation; an older one that is still on its way gives way to it. */
	private readonly sending = new Map<string, object>()
	private readonly clock: CiWatchClock
	private readonly timings: CiWatchTimings
	private readonly maxWakeUps: number
	private readonly retryMs: number
	private readonly maxRetries: number

	constructor(
		private readonly host: CiWatchConversationHost,
		options: CiWatchManagerOptions = {},
	) {
		this.clock = options.clock ?? SYSTEM_CLOCK
		this.timings = options.timings ?? DEFAULT_CI_WATCH_TIMINGS
		this.maxWakeUps = options.maxWakeUps ?? MAX_WAKE_UPS
		this.retryMs = options.retryMs ?? RETRY_MS
		this.maxRetries = options.maxRetries ?? MAX_RETRIES
	}

	/** What the conversation is watching, if anything. */
	watching(conversationId: string): string | undefined {
		return this.watches.get(conversationId)?.label
	}

	/** Starts a watch, replacing the conversation's previous one. Returns the label of the replaced watch. */
	watch(conversationId: string, request: CiWatchRequest): string | undefined {
		const replaced = this.stop(conversationId)
		const watch: ActiveWatch = {
			label: request.label,
			watcher: new CiWatcher({
				source: request.source,
				head: request.head,
				until: request.until,
				clock: this.clock,
				timings: this.timings,
				onOutcome: (outcome) => this.handleOutcome(conversationId, watch, request, outcome),
			}),
		}
		this.watches.set(conversationId, watch)
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
			Logger.log(`[CiWatch] ${conversationId}: stopped watching ${label}`)
			this.host.showRow(conversationId, ciWatchRow(`Stopped watching CI for ${label}.`))
		}
		return label
	}

	/** The user wrote in the conversation, so it is attended again. */
	noteUserMessage(conversationId: string): void {
		this.wakeUps.delete(conversationId)
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
		this.wakeUps.delete(conversationId)
	}

	/** Stops every watch and drops every report that was not sent yet. */
	clear(): void {
		const known = [this.watches, this.retries, this.sending, this.held, this.wakeUps].flatMap((map) => [...map.keys()])
		for (const conversationId of new Set(known)) {
			this.removeConversation(conversationId)
		}
	}

	private stop(conversationId: string): string | undefined {
		const watch = this.watches.get(conversationId)
		watch?.watcher.cancel()
		this.watches.delete(conversationId)
		return watch?.label
	}

	private clearRetry(conversationId: string): void {
		this.clock.clearTimeout(this.retries.get(conversationId))
		this.retries.delete(conversationId)
	}

	private handleOutcome(conversationId: string, watch: ActiveWatch, request: CiWatchRequest, outcome: CiWatchOutcome): void {
		if (this.watches.get(conversationId) !== watch) {
			return
		}
		this.watches.delete(conversationId)
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
			const why =
				`PlinyCode did not send this result to the agent, because the CI watcher has already woken this conversation ` +
				`${this.maxWakeUps} times in a row without a message from you. Send a message there to let the agent react to CI again.`
			Logger.log(`[CiWatch] ${conversationId}: wake-up limit reached; notifying only`)
			this.host.showRow(conversationId, ciWatchRow(`${message.headline} ${why}`))
			this.host.notify(conversationId, `PlinyCode CI watcher: ${message.headline} ${why}`)
			return
		}
		const token = {}
		this.sending.set(conversationId, token)
		let delivery: CiWatchDelivery
		try {
			delivery = await this.host.deliver(conversationId, message.prompt)
		} catch (error) {
			Logger.warn(`[CiWatch] ${conversationId}: could not deliver the report: ${error}`)
			delivery = "unavailable"
		}
		if (this.sending.get(conversationId) !== token) {
			// The conversation was deleted, or a newer report took over, while this one was on its way.
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
		if (delivery === "started" || delivery === "queued") {
			this.wakeUps.set(conversationId, (this.wakeUps.get(conversationId) ?? 0) + 1)
			return
		}
		this.held.set(conversationId, message)
		if (options.announce) {
			this.host.notify(
				conversationId,
				`PlinyCode CI watcher: ${message.headline} Open the conversation to send this result to the agent.`,
			)
		}
	}
}
