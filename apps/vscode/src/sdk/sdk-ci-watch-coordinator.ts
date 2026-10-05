import { isCiWatchReport } from "@shared/ciWatch"
import type { TurnPhase } from "@shared/ExtensionMessage"
import { getCiWatchManager, setCiWatchManager } from "@/services/devops-mcp/builtin-mcp-registry"
import {
	type CiWatchConversationHost,
	type CiWatchDelivery,
	CiWatchManager,
} from "@/services/devops-mcp/ci-watch/ci-watch-manager"
import type { ActiveSession } from "./cline-session-factory"

interface SdkCiWatchCoordinatorOptions {
	/** The conversation shown in the chat view. */
	getDisplayedTaskId: () => string | undefined
	getActiveSession: () => ActiveSession | undefined
	getTurnPhase: () => TurnPhase
	/** A tool approval or an ask_question is waiting for the user. */
	hasPendingInteraction: () => boolean
	/** Queues a prompt on the foreground session; the engine runs it when the current turn ends. */
	queueToActiveSession: (session: ActiveSession, prompt: string) => void
	/** Queues a prompt on a task that runs in the background. False when the task is not one. */
	queueToBackgroundTask: (conversationId: string, prompt: string) => boolean
	/** Starts a turn in the displayed conversation, the way a follow-up message does. */
	startTurn: (prompt: string) => Promise<void>
	/** Adds an informational row to the displayed conversation. */
	emitRow: (text: string) => void
	/** Shows a notification with an Open action. */
	notify: (message: string, onOpen: () => void) => void
	openTask: (conversationId: string) => void
	managerOptions?: ConstructorParameters<typeof CiWatchManager>[1]
}

/**
 * The controller's side of the CI watcher (docs/devops-mcp.md): owns the
 * window's watches and gets their reports into conversations.
 *
 * A report is a prompt. How it is delivered depends on where the conversation
 * is when CI ends:
 * - on screen and idle: it starts a turn, like a follow-up the user sends;
 * - mid-turn, on screen or in the background: it joins the engine's prompt
 *   queue, which runs it when the turn ends;
 * - not loaded: the manager keeps it, notifies the user, and sends it when the
 *   conversation is opened.
 */
export class SdkCiWatchCoordinator implements CiWatchConversationHost {
	readonly manager: CiWatchManager

	constructor(private readonly options: SdkCiWatchCoordinatorOptions) {
		this.manager = new CiWatchManager(this, options.managerOptions)
		setCiWatchManager(this.manager)
	}

	async deliver(conversationId: string, prompt: string): Promise<CiWatchDelivery> {
		if (this.options.queueToBackgroundTask(conversationId, prompt)) {
			return "queued"
		}
		if (this.options.getDisplayedTaskId() !== conversationId) {
			return "unavailable"
		}
		const session = this.options.getActiveSession()
		const phase = this.options.getTurnPhase()
		const midTurn = phase === "streaming" || phase === "awaiting_approval" || this.options.hasPendingInteraction()
		if (session?.sessionId === conversationId && (session.isRunning || midTurn)) {
			// Never startTurn here: with an approval or a question pending, a
			// follow-up is taken as the user's answer to it.
			this.options.queueToActiveSession(session, prompt)
			return "queued"
		}
		if (midTurn || (session && session.sessionId !== conversationId)) {
			// The conversation's session is being started, resumed or replaced.
			// Starting a turn now could start a second session beside it.
			return "busy"
		}
		await this.options.startTurn(prompt)
		return "started"
	}

	showRow(conversationId: string, text: string): void {
		if (this.options.getDisplayedTaskId() === conversationId) {
			this.options.emitRow(text)
		}
	}

	notify(conversationId: string, message: string): void {
		this.options.notify(message, () => this.options.openTask(conversationId))
	}

	/**
	 * Called for every follow-up that reaches the displayed conversation. One
	 * the user wrote lifts the limit on automatic wake-ups; the watcher's own
	 * reports come through here too and must not.
	 */
	noteFollowUp(prompt?: string, images?: string[], files?: string[]): void {
		const conversationId = this.options.getDisplayedTaskId()
		const hasContent = !!prompt?.trim() || !!images?.length || !!files?.length
		if (conversationId && hasContent && !isCiWatchReport(prompt)) {
			this.manager.noteUserMessage(conversationId)
		}
	}

	dispose(): void {
		this.manager.clear()
		if (getCiWatchManager() === this.manager) {
			setCiWatchManager(undefined)
		}
	}
}
