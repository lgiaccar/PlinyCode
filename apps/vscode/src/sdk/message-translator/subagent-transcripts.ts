// Live transcripts of the sub-agents of the open conversation, one per engine
// agent id. The root's chat shows a sub-agent only as an item of its status
// row; expanding that item streams the transcript kept here
// (TaskService.subscribeToSubagentMessages, docs/agent-tools.md "Sub-agents").
//
// Each sub-agent's events go through the same translation as the root's, but
// against a translator state of its own, so its text, tool and command rows
// look like the main chat's and its streaming pointers never touch the root's.
// A second-level sub-agent is just another entry: its parent's transcript holds
// the parent's own `spawn_agent` status row, whose items point at it by id.

import type { AgentEvent } from "@plinycode/shared"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import type { MessageTranslatorState } from "./translator-state"

/** Messages kept per sub-agent; older ones are dropped first. */
const SUBAGENT_TRANSCRIPT_MAX_MESSAGES = 300
/** Sub-agents kept per conversation; the transcript of the oldest one goes first. */
const SUBAGENT_TRANSCRIPT_MAX_AGENTS = 20

/**
 * One change to a transcript. `reset` means `messages` is the whole transcript
 * (the first update of a subscription); otherwise they are messages added or
 * changed since the last update, matched by `ts`.
 */
export interface SubagentTranscriptUpdate {
	reset: boolean
	messages: ClineMessage[]
}

type Listener = (update: SubagentTranscriptUpdate) => void

/**
 * A sub-agent's final answer is a report to its parent, not the end of the user's
 * task: show it as text, without the completion box's view-changes or execute-plan
 * actions, which act on the conversation.
 */
function asTranscriptRow(message: ClineMessage): ClineMessage {
	return message.say === "completion_result" || message.say === "plan_completion_result" ? { ...message, say: "text" } : message
}

interface Transcript {
	state: MessageTranslatorState
	messages: ClineMessage[]
}

export class SubagentTranscripts {
	private readonly transcripts = new Map<string, Transcript>()
	private readonly listeners = new Map<string, Set<Listener>>()

	constructor(
		private readonly createState: () => MessageTranslatorState,
		private readonly limits = {
			maxMessages: SUBAGENT_TRANSCRIPT_MAX_MESSAGES,
			maxAgents: SUBAGENT_TRANSCRIPT_MAX_AGENTS,
		},
	) {}

	/** Whether events of this agent id are filed here. */
	has(agentId: string): boolean {
		return this.transcripts.has(agentId)
	}

	/**
	 * File one of a sub-agent's events in its transcript. `translate` turns the
	 * event into chat messages against the sub-agent's own translator state.
	 * Asks are left out: approvals and errors are answered in the main chat.
	 */
	record(event: AgentEvent, translate: (event: AgentEvent, state: MessageTranslatorState) => ClineMessage[]): void {
		const agentId = event.agentId
		if (!agentId) {
			Logger.debug(`[SubagentTranscripts] Dropped a sub-agent ${event.type} event that names no agent`)
			return
		}
		const transcript = this.transcriptFor(agentId)
		const messages = translate(event, transcript.state)
			.filter((message) => message.type !== "ask")
			.map(asTranscriptRow)
		if (messages.length === 0) {
			return
		}
		const changed = messages.filter((message) => this.upsert(transcript, message))
		if (changed.length > 0) {
			this.emit(agentId, { reset: false, messages: changed })
		}
	}

	/** The messages kept for a sub-agent, oldest first; empty for an unknown id. */
	snapshot(agentId: string): ClineMessage[] {
		return [...(this.transcripts.get(agentId)?.messages ?? [])]
	}

	/** Receive each later change to one sub-agent's transcript. Returns the unsubscribe function. */
	subscribe(agentId: string, listener: Listener): () => void {
		let set = this.listeners.get(agentId)
		if (!set) {
			set = new Set()
			this.listeners.set(agentId, set)
		}
		set.add(listener)
		return () => {
			const current = this.listeners.get(agentId)
			current?.delete(listener)
			if (current?.size === 0) {
				this.listeners.delete(agentId)
			}
		}
	}

	/** Forget every transcript (a new or switched conversation). Open views are told to empty. */
	clear(): void {
		const ids = [...this.transcripts.keys()]
		this.transcripts.clear()
		for (const agentId of ids) {
			this.emit(agentId, { reset: true, messages: [] })
		}
	}

	private transcriptFor(agentId: string): Transcript {
		const existing = this.transcripts.get(agentId)
		if (existing) {
			return existing
		}
		const transcript: Transcript = { state: this.createState(), messages: [] }
		this.transcripts.set(agentId, transcript)
		// Map order is insertion order: the first key is the oldest sub-agent.
		while (this.transcripts.size > this.limits.maxAgents) {
			const oldest = this.transcripts.keys().next().value as string
			this.transcripts.delete(oldest)
			this.emit(oldest, { reset: true, messages: [] })
		}
		return transcript
	}

	/** Add or replace a message by ts. False when it belongs to the part already dropped. */
	private upsert(transcript: Transcript, message: ClineMessage): boolean {
		const messages = transcript.messages
		// Updates are almost always to the newest rows, so search from the end.
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].ts === message.ts) {
				messages[i] = message
				return true
			}
		}
		if (messages.length >= this.limits.maxMessages && message.ts < messages[0].ts) {
			return false
		}
		messages.push(message)
		if (messages.length > this.limits.maxMessages) {
			messages.splice(0, messages.length - this.limits.maxMessages)
		}
		return true
	}

	private emit(agentId: string, update: SubagentTranscriptUpdate): void {
		for (const listener of this.listeners.get(agentId) ?? []) {
			try {
				listener(update)
			} catch (error) {
				Logger.error("[SubagentTranscripts] A transcript listener failed:", error)
			}
		}
	}
}
