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
import type { MemoryStore } from "./memory-store"

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
	isActMode: () => boolean
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
	/** Per conversation: messages already distilled, so an offer only covers what is new. */
	private readonly distilledUpTo = new Map<string, number>()
	private readonly running = new Set<string>()

	constructor(private readonly deps: MemoryCoordinatorDeps) {}

	private get pendingDir(): string {
		return path.join(this.deps.store.rootDir, "pending")
	}

	private pendingFile(conversationId: string): string {
		return path.join(this.pendingDir, `${conversationId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`)
	}

	/** Called when a send completes. Offers memories when the run edited files and the conversation is shown. */
	async maybeOfferDistill(sessionId: string): Promise<void> {
		if (
			!this.deps.isOfferEnabled() ||
			!this.deps.isActMode() ||
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
		this.distilledUpTo.delete(conversationId)
		await this.distill(conversationId, messages, { manual: true })
	}

	private async distill(conversationId: string, messages: unknown[], options: { manual: boolean }): Promise<void> {
		if (this.running.has(conversationId)) {
			return
		}
		const from = options.manual ? 0 : (this.distilledUpTo.get(conversationId) ?? 0)
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
			this.distilledUpTo.set(conversationId, messages.length)
			const memories = parseDistillReply(reply, `${memory.repoText}\n${memory.userText}`)
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
		if (!save) {
			record.proposal = { ...record.proposal, status: "dismissed" }
			this.show(record)
			await this.forget(record)
			return
		}
		const chosen = record.proposal.items.filter((item) => itemIds.includes(item.id))
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
