// Runs memory distillation for the controller and handles the user's choice
// on its chat row (docs/memory.md).
//
// - After an act-mode run that edited files, `maybeOfferDistill` asks a free
//   utility model what is worth remembering. `/distill` runs the same thing on
//   demand, for the whole conversation.
// - Proposals appear as a `memory_proposal` row. Nothing is saved until the
//   user picks the items and presses Save (`resolveProposal`).
// - Rows the extension emits are not part of the transcript, so a pending
//   proposal is also written to `<memory dir>/pending/<conversation>.json` and
//   shown again when the conversation is reopened, until it is resolved.
// - How far each conversation was distilled, and the memories the user
//   dismissed or left unchecked, are kept in `<memory dir>/distill/<conversation>.json`,
//   so a reload neither re-reads the whole conversation nor proposes them again.

import { promises as fs } from "node:fs"
import * as path from "node:path"
import { isOffTheRecordTurnActive, isUserRunMessage } from "@plinycode/core"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { type MemoryProposal, type MemoryProposalItem, parseMemoryProposal } from "@shared/memory-proposal"
import { Logger } from "@/shared/services/Logger"
import {
	buildDistillTranscript,
	buildDistillUserPrompt,
	DISTILL_SYSTEM_PROMPT,
	hasSuccessfulEdit,
	parseDistillReply,
} from "./memory-distiller"
import { memoryEntryKey } from "./memory-file"
import type { MemoryStore } from "./memory-store"

/** What is kept per conversation between windows: see the header. */
interface DistillState {
	upTo: number
	dismissed: string[]
}

/** Dismissed keys kept per conversation; the oldest go first. */
const MAX_DISMISSED_KEYS = 200

function safeFileName(conversationId: string): string {
	return conversationId.replace(/[^a-zA-Z0-9._-]/g, "_")
}

const DISTILL_TIMEOUT_MS = 90_000

export interface MemoryCoordinatorDeps {
	store: MemoryStore
	emitRow: (message: ClineMessage) => void
	nextMessageTs: () => number
	/** The conversation shown in the chat. Rows only go to it. */
	getDisplayedConversationId: () => string | undefined
	readMessages: (conversationId: string) => Promise<unknown[]>
	/** The folder the displayed conversation runs in. */
	getCwd: () => Promise<string>
	/** One call to the distillation model; resolves with its reply text. */
	complete: (system: string, user: string, signal: AbortSignal) => Promise<string>
	isOfferEnabled: () => boolean
	/** Whether the session ran in act mode: its own mode, not the mode switch's current position. */
	isActMode: (sessionId: string) => boolean
	isBackgroundSession: (sessionId: string) => boolean
}

interface PendingRecord {
	proposal: MemoryProposal
	cwd: string
	/** The row's ts, so an update replaces it. */
	ts?: number
}

/** The index of the newest user message that starts a run: what the last run did starts there. */
function lastUserRunStart(messages: readonly unknown[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (isUserRunMessage(messages[index] as Parameters<typeof isUserRunMessage>[0])) return index
	}
	return 0
}

export class MemoryCoordinator {
	private readonly pending = new Map<string, PendingRecord>()
	/**
	 * Per conversation: messages already distilled, so an offer only covers
	 * what is new, and the memories not to propose again. Loaded from disk the
	 * first time a conversation is distilled in this window.
	 */
	private readonly states = new Map<string, DistillState>()
	private readonly running = new Set<string>()

	constructor(private readonly deps: MemoryCoordinatorDeps) {}

	private get pendingDir(): string {
		return path.join(this.deps.store.rootDir, "pending")
	}

	private pendingFile(conversationId: string): string {
		return path.join(this.pendingDir, `${safeFileName(conversationId)}.json`)
	}

	private stateFile(conversationId: string): string {
		return path.join(this.deps.store.rootDir, "distill", `${safeFileName(conversationId)}.json`)
	}

	private async loadState(conversationId: string): Promise<DistillState> {
		const known = this.states.get(conversationId)
		if (known) {
			return known
		}
		let state: DistillState = { upTo: 0, dismissed: [] }
		try {
			const stored = JSON.parse(await fs.readFile(this.stateFile(conversationId), "utf8")) as Partial<DistillState>
			state = {
				upTo: typeof stored.upTo === "number" && stored.upTo > 0 ? stored.upTo : 0,
				dismissed: Array.isArray(stored.dismissed) ? stored.dismissed.filter((key) => typeof key === "string") : [],
			}
		} catch {
			// Never distilled, or the file is unreadable: start from the beginning.
		}
		this.states.set(conversationId, state)
		return state
	}

	private async saveState(conversationId: string, state: DistillState): Promise<void> {
		this.states.set(conversationId, state)
		try {
			const file = this.stateFile(conversationId)
			await fs.mkdir(path.dirname(file), { recursive: true })
			await fs.writeFile(file, JSON.stringify(state), "utf8")
		} catch (error) {
			Logger.debug("[Memory] Failed to store the distillation state:", error)
		}
	}

	/** Remembers memories the user chose not to keep, so they are not proposed again. */
	private async rememberDismissed(conversationId: string, texts: readonly string[]): Promise<void> {
		if (texts.length === 0) {
			return
		}
		const state = await this.loadState(conversationId)
		const dismissed = [...new Set([...state.dismissed, ...texts.map(memoryEntryKey)])].slice(-MAX_DISMISSED_KEYS)
		await this.saveState(conversationId, { ...state, dismissed })
	}

	/** Called when a send completes. Offers memories when the run edited files and the conversation is shown. */
	async maybeOfferDistill(sessionId: string): Promise<void> {
		if (
			!this.deps.isOfferEnabled() ||
			!this.deps.isActMode(sessionId) ||
			this.deps.isBackgroundSession(sessionId) ||
			this.deps.getDisplayedConversationId() !== sessionId
		) {
			return
		}
		const messages = await this.deps.readMessages(sessionId).catch(() => [] as unknown[])
		// A side question's run edits nothing and is not to be remembered.
		if (messages.length === 0 || isOffTheRecordTurnActive(messages as Parameters<typeof isOffTheRecordTurnActive>[0])) {
			return
		}
		if (!hasSuccessfulEdit(messages, lastUserRunStart(messages))) {
			return
		}
		await this.distill(sessionId, messages, { manual: false })
	}

	/** `/distill`: proposes memories from the whole displayed conversation. */
	async distillNow(): Promise<void> {
		const conversationId = this.deps.getDisplayedConversationId()
		if (!conversationId) {
			this.info("Start or open a conversation first: /distill proposes memories from the conversation shown.")
			return
		}
		const messages = await this.deps.readMessages(conversationId).catch(() => [] as unknown[])
		await this.distill(conversationId, messages, { manual: true })
	}

	private async distill(conversationId: string, messages: unknown[], options: { manual: boolean }): Promise<void> {
		if (this.running.has(conversationId)) {
			return
		}
		const state = await this.loadState(conversationId)
		const from = options.manual ? 0 : Math.min(state.upTo, messages.length)
		const transcript = buildDistillTranscript(messages, from)
		if (!transcript.trim()) {
			if (options.manual) this.info("There is nothing in this conversation to distill yet.")
			return
		}
		this.running.add(conversationId)
		try {
			const cwd = await this.deps.getCwd()
			const memory = await this.deps.store.read(cwd)
			if (options.manual) {
				this.info("Looking for memories worth keeping in this conversation…")
			}
			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), DISTILL_TIMEOUT_MS)
			let reply: string
			try {
				reply = await this.deps.complete(
					DISTILL_SYSTEM_PROMPT,
					buildDistillUserPrompt(transcript, memory.repoText, memory.userText),
					controller.signal,
				)
			} finally {
				clearTimeout(timer)
			}
			const latest = await this.loadState(conversationId)
			await this.saveState(conversationId, { ...latest, upTo: messages.length })
			const memories = parseDistillReply(reply, `${memory.repoText}\n${memory.userText}`, new Set(latest.dismissed))
			if (memories.length === 0) {
				if (options.manual) this.info("No new memories found in this conversation.")
				return
			}
			// The user may have moved on while the model was thinking.
			if (this.deps.getDisplayedConversationId() !== conversationId) {
				return
			}
			const proposal: MemoryProposal = {
				id: `${conversationId}-${Date.now()}`,
				conversationId,
				status: "pending",
				items: memories.map(
					(memory, index): MemoryProposalItem => ({
						id: String(index),
						scope: memory.scope,
						text: memory.text,
						importance: memory.importance,
					}),
				),
				repo: memory.location.repo.identity,
			}
			const record: PendingRecord = { proposal, cwd }
			this.show(record)
			await this.persist(record)
		} catch (error) {
			Logger.warn("[Memory] Distillation failed:", error)
			if (options.manual) {
				this.info(`Could not distill memories: ${error instanceof Error ? error.message : String(error)}`)
			}
		} finally {
			this.running.delete(conversationId)
		}
	}

	/** The user's choice on a proposal row: save the checked items, or dismiss it. */
	async resolveProposal(proposalId: string, save: boolean, itemIds: readonly string[]): Promise<void> {
		const record = [...this.pending.values()].find((candidate) => candidate.proposal.id === proposalId)
		if (!record || record.proposal.status !== "pending") {
			return
		}
		const conversationId = record.proposal.conversationId
		if (!save) {
			record.proposal = { ...record.proposal, status: "dismissed" }
			this.show(record)
			await this.rememberDismissed(
				conversationId,
				record.proposal.items.map((item) => item.text),
			)
			await this.forget(record)
			return
		}
		const chosen = record.proposal.items.filter((item) => itemIds.includes(item.id))
		await this.rememberDismissed(
			conversationId,
			record.proposal.items.filter((item) => !itemIds.includes(item.id)).map((item) => item.text),
		)
		record.proposal = { ...record.proposal, status: "saving" }
		this.show(record)
		let saved = 0
		try {
			for (const item of chosen) {
				const result = await this.deps.store.save(record.cwd, {
					scope: item.scope,
					text: item.text,
					importance: item.importance,
				})
				if (result.inserted) saved++
			}
			record.proposal = { ...record.proposal, status: "saved", savedCount: saved }
		} catch (error) {
			record.proposal = {
				...record.proposal,
				status: "pending",
				error: `Saving failed: ${error instanceof Error ? error.message : String(error)}`,
			}
			this.show(record)
			return
		}
		this.show(record)
		await this.forget(record)
	}

	/** Shows the conversation's unresolved proposal again, at the end of the chat. Called when a conversation is opened. */
	async showPending(conversationId: string): Promise<void> {
		let record = this.pending.get(conversationId)
		if (!record) {
			try {
				const stored = JSON.parse(await fs.readFile(this.pendingFile(conversationId), "utf8")) as {
					proposal?: unknown
					cwd?: unknown
				}
				const proposal = parseMemoryProposal(JSON.stringify(stored.proposal))
				if (proposal && typeof stored.cwd === "string" && proposal.status === "pending") {
					record = { proposal, cwd: stored.cwd }
					this.pending.set(conversationId, record)
				}
			} catch {
				return
			}
		}
		if (record && record.proposal.status === "pending") {
			record.ts = undefined
			this.show(record)
		}
	}

	private show(record: PendingRecord): void {
		if (this.deps.getDisplayedConversationId() !== record.proposal.conversationId) {
			return
		}
		record.ts ??= this.deps.nextMessageTs()
		this.pending.set(record.proposal.conversationId, record)
		this.deps.emitRow({
			ts: record.ts,
			type: "say",
			say: "memory_proposal",
			text: JSON.stringify(record.proposal),
			partial: false,
		})
	}

	private info(text: string): void {
		this.deps.emitRow({ ts: this.deps.nextMessageTs(), type: "say", say: "info", text, partial: false })
	}

	private async persist(record: PendingRecord): Promise<void> {
		try {
			await fs.mkdir(this.pendingDir, { recursive: true })
			const content = JSON.stringify({ proposal: record.proposal, cwd: record.cwd }, null, 2)
			await fs.writeFile(this.pendingFile(record.proposal.conversationId), content, "utf8")
		} catch (error) {
			Logger.debug("[Memory] Failed to store the pending proposal:", error)
		}
	}

	private async forget(record: PendingRecord): Promise<void> {
		this.pending.delete(record.proposal.conversationId)
		await fs.rm(this.pendingFile(record.proposal.conversationId), { force: true }).catch(() => {})
	}
}
