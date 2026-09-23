import type { CoreSessionEvent } from "@plinycode/core"
import { Logger } from "@/shared/services/Logger"
import type { ActiveSession } from "./cline-session-factory"
import type {
	BackgroundInteractionSink,
	HeldQuestion,
	HeldToolApproval,
	ToolApprovalRequest,
	ToolApprovalResult,
} from "./sdk-interaction-coordinator"

/** Maximum number of tasks kept running in the background at once. */
export const MAX_BACKGROUND_SESSIONS = 3

/**
 * How long to wait after a turn's `done` before treating the task as idle. A
 * queued prompt is drained right after `done`; waiting lets its
 * `pending_prompt_submitted` arrive first so the task is not stopped mid-queue.
 */
const IDLE_SETTLE_MS = 750

export type BackgroundTaskStatus = "running" | "needs_attention"

export interface BackgroundTaskInfo {
	id: string
	status: BackgroundTaskStatus
}

/** What a task that was moved back to the foreground was still waiting on. */
export interface HeldInteractions {
	approvals: HeldToolApproval[]
	questions: HeldQuestion[]
}

interface BackgroundEntry {
	session: ActiveSession
	title: string
	approvals: HeldToolApproval[]
	questions: HeldQuestion[]
	/** Bumped whenever a new turn starts, so a stale idle check is ignored. */
	turnGeneration: number
	/** spawn_agent calls in flight; their sub-agents' `done` events are not ours. */
	runningSubagents: number
	lastDoneReason?: string
}

export interface SdkBackgroundSessionsOptions {
	/** Stops a finished (or no longer wanted) background session. */
	stopSession: (session: ActiveSession, reason: string) => Promise<void>
	/** Persists token/cost usage reported by a background session. */
	recordUsage: (sessionId: string, event: Extract<CoreSessionEvent, { type: "agent_event" }>["payload"]["event"]) => void
	/** Shows a non-modal notification; `onOpen` reopens the task when its action is chosen. */
	notify: (message: string, onOpen: () => void) => void
	/** Reopens a task in the chat view. */
	openTask: (sessionId: string) => void
	/** Background task list changed (badges in History). */
	onChanged: () => void
	maxSessions?: number
	idleSettleMs?: number
}

/**
 * Tasks that keep running after the user starts a new task or opens another
 * one from History. While in the background a task produces no chat output;
 * the SDK persists its conversation, so reopening it rebuilds the transcript.
 * Approvals and questions are held until the task is reopened. When a task
 * finishes its turn it is stopped and the user is notified.
 */
export class SdkBackgroundSessions implements BackgroundInteractionSink {
	private readonly entries = new Map<string, BackgroundEntry>()
	private readonly maxSessions: number
	private readonly idleSettleMs: number

	constructor(private readonly options: SdkBackgroundSessionsOptions) {
		this.maxSessions = options.maxSessions ?? MAX_BACKGROUND_SESSIONS
		this.idleSettleMs = options.idleSettleMs ?? IDLE_SETTLE_MS
	}

	has(sessionId: string | undefined): boolean {
		return sessionId !== undefined && this.entries.has(sessionId)
	}

	get isFull(): boolean {
		return this.entries.size >= this.maxSessions
	}

	list(): BackgroundTaskInfo[] {
		return [...this.entries.entries()].map(([id, entry]) => ({ id, status: this.statusOf(entry) }))
	}

	/**
	 * Move a running session to the background, with any approval/question it
	 * was already waiting on. Returns false when the limit is reached.
	 */
	add(session: ActiveSession, title: string, held: Partial<HeldInteractions> = {}): boolean {
		if (this.isFull || this.entries.has(session.sessionId)) {
			return false
		}
		this.entries.set(session.sessionId, {
			session,
			title: summarizeTitle(title),
			approvals: [...(held.approvals ?? [])],
			questions: [...(held.questions ?? [])],
			turnGeneration: 0,
			runningSubagents: 0,
		})
		Logger.log(`[BackgroundSessions] Task ${session.sessionId} continues in the background`)
		this.options.onChanged()
		return true
	}

	/**
	 * Remove a session to bring it back to the foreground. `turnEnded` is true
	 * when its turn already finished (the idle check had not run yet): the
	 * caller should stop it and open the task normally instead of adopting it.
	 */
	take(sessionId: string): { session: ActiveSession; held: HeldInteractions; turnEnded: boolean } | undefined {
		const entry = this.entries.get(sessionId)
		if (!entry) {
			return undefined
		}
		this.entries.delete(sessionId)
		this.options.onChanged()
		return {
			session: entry.session,
			held: { approvals: entry.approvals, questions: entry.questions },
			turnEnded: entry.lastDoneReason !== undefined,
		}
	}

	holdApproval(sessionId: string, request: ToolApprovalRequest): Promise<ToolApprovalResult> {
		const entry = this.entries.get(sessionId)
		if (!entry) {
			return Promise.resolve({ approved: false, reason: "Task is no longer running" })
		}
		return new Promise<ToolApprovalResult>((resolve) => {
			entry.approvals.push({ request, resolve })
			this.notifyNeedsAttention(sessionId, entry, "needs your approval")
		})
	}

	holdQuestion(sessionId: string, question: string, options: string[], context: unknown): Promise<string> {
		const entry = this.entries.get(sessionId)
		if (!entry) {
			return Promise.resolve("")
		}
		return new Promise<string>((resolve) => {
			entry.questions.push({ question, options, context, resolve })
			this.notifyNeedsAttention(sessionId, entry, "has a question for you")
		})
	}

	/**
	 * Consume an event if it belongs to a background session. Returns true when
	 * it did, so the caller skips all foreground (chat view) handling.
	 */
	handleEvent(event: CoreSessionEvent): boolean {
		const sessionId = event.payload.sessionId
		const entry = this.entries.get(sessionId)
		if (!entry) {
			return false
		}

		switch (event.type) {
			case "pending_prompt_submitted":
				entry.turnGeneration++
				entry.lastDoneReason = undefined
				break
			case "ended":
				void this.finish(sessionId, entry, "ended")
				break
			case "agent_event": {
				const agentEvent = event.payload.event
				if (agentEvent.parentAgentId) {
					break
				}
				if (
					(agentEvent.type === "content_start" || agentEvent.type === "content_end") &&
					agentEvent.contentType === "tool" &&
					agentEvent.toolName === "spawn_agent"
				) {
					entry.runningSubagents = Math.max(0, entry.runningSubagents + (agentEvent.type === "content_start" ? 1 : -1))
					break
				}
				if (agentEvent.type === "usage") {
					this.options.recordUsage(sessionId, agentEvent)
				} else if (agentEvent.type === "done" && entry.runningSubagents === 0) {
					entry.lastDoneReason = agentEvent.reason
					this.scheduleIdleCheck(sessionId, entry)
				}
				break
			}
		}
		return true
	}

	/**
	 * A send started while the task was in the foreground settled after it
	 * moved to the background. Treated like a turn end.
	 */
	handleSendSettled(sessionId: string, error?: unknown): void {
		const entry = this.entries.get(sessionId)
		if (!entry) {
			return
		}
		if (error !== undefined && entry.lastDoneReason === undefined) {
			entry.lastDoneReason = "error"
		}
		this.scheduleIdleCheck(sessionId, entry)
	}

	/** Stop one background session, e.g. because its task was deleted. */
	async stopTask(sessionId: string, reason: string): Promise<void> {
		const entry = this.entries.get(sessionId)
		if (!entry) {
			return
		}
		this.entries.delete(sessionId)
		this.rejectHeld(entry, reason)
		this.options.onChanged()
		await this.options.stopSession(entry.session, reason)
	}

	/** Stop every background session (extension shutdown, delete all history). */
	async stopAll(reason: string): Promise<void> {
		await Promise.all([...this.entries.keys()].map((id) => this.stopTask(id, reason)))
	}

	private statusOf(entry: BackgroundEntry): BackgroundTaskStatus {
		return entry.approvals.length > 0 || entry.questions.length > 0 ? "needs_attention" : "running"
	}

	private notifyNeedsAttention(sessionId: string, entry: BackgroundEntry, what: string): void {
		this.options.onChanged()
		this.options.notify(`PlinyCode task "${entry.title}" ${what}.`, () => this.options.openTask(sessionId))
	}

	private scheduleIdleCheck(sessionId: string, entry: BackgroundEntry): void {
		const generation = entry.turnGeneration
		setTimeout(() => {
			void this.checkIdle(sessionId, generation).catch((error) => {
				Logger.warn(`[BackgroundSessions] Idle check failed for ${sessionId}:`, error)
			})
		}, this.idleSettleMs)
	}

	private async checkIdle(sessionId: string, generation: number): Promise<void> {
		const entry = this.entries.get(sessionId)
		if (!entry || entry.turnGeneration !== generation) {
			return
		}
		if (entry.approvals.length > 0 || entry.questions.length > 0) {
			return
		}
		const pending = await entry.session.sdkHost.pendingPrompts("list", { sessionId }).catch(() => [])
		if (pending.length > 0 || this.entries.get(sessionId) !== entry || entry.turnGeneration !== generation) {
			return
		}
		await this.finish(sessionId, entry, entry.lastDoneReason ?? "completed")
	}

	private async finish(sessionId: string, entry: BackgroundEntry, reason: string): Promise<void> {
		if (this.entries.get(sessionId) !== entry) {
			return
		}
		this.entries.delete(sessionId)
		this.rejectHeld(entry, "Task finished")
		this.options.onChanged()
		await this.options.stopSession(entry.session, "backgroundTaskFinished")
		const outcome =
			reason === "error" || reason === "mistake_limit"
				? "stopped with an error"
				: reason === "aborted"
					? "was stopped"
					: "finished"
		Logger.log(`[BackgroundSessions] Background task ${sessionId} ${outcome} (${reason})`)
		this.options.notify(`PlinyCode task "${entry.title}" ${outcome}.`, () => this.options.openTask(sessionId))
	}

	private rejectHeld(entry: BackgroundEntry, reason: string): void {
		for (const approval of entry.approvals) {
			approval.resolve({ approved: false, reason })
		}
		for (const question of entry.questions) {
			question.resolve("")
		}
		entry.approvals = []
		entry.questions = []
	}
}

function summarizeTitle(title: string): string {
	const singleLine = title.replace(/\s+/g, " ").trim() || "Untitled task"
	return singleLine.length > 60 ? `${singleLine.slice(0, 57)}…` : singleLine
}
