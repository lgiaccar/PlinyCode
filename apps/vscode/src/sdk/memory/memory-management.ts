import { promises as fs } from "node:fs"
import * as path from "node:path"
import { MEMORY_TYPES, type MemoryScope, type MemoryTuning } from "@shared/memory"
import type { MemoryPanelState } from "@shared/memory-panel"
import { openMemoryPromotionDraft } from "@/hosts/vscode/memory-promotion"
import {
	getMemoryBudget,
	getMemoryDistillMode,
	getMemoryTuning,
	setMemoryBudget,
	setMemoryDistillMode,
	setMemoryTuning,
} from "@/hosts/vscode/memory-settings"
import type { ConversationMemorySnapshots } from "./conversation-memory-snapshots"
import type { MemoryCoordinator } from "./memory-coordinator"
import type { MemoryStore } from "./memory-store"

function scope(value: unknown): MemoryScope {
	if (value !== "repo" && value !== "group" && value !== "user") throw new Error("Invalid memory scope")
	return value
}

/** Draft a convention in the nearest AGENTS.md. Only an explicit Finish removes the memory. */
async function promotionTarget(cwd: string): Promise<string> {
	let folder = path.resolve(cwd)
	while (true) {
		const file = path.join(folder, "AGENTS.md")
		if (
			await fs
				.stat(file)
				.then((stat) => stat.isFile())
				.catch(() => false)
		)
			return file
		const parent = path.dirname(folder)
		if (parent === folder) return path.join(cwd, "AGENTS.md")
		folder = parent
	}
}

export async function manageMemory(
	store: MemoryStore,
	snapshots: ConversationMemorySnapshots,
	coordinator: MemoryCoordinator,
	cwd: string,
	conversationId: string | undefined,
	input: Record<string, unknown>,
): Promise<MemoryPanelState> {
	await coordinator.inbox(cwd)
	const entries = await store.entries(cwd)
	const entry = entries.find((item) => item.id === input.id)
	if (["edit", "delete", "move", "promote", "finishPromotion"].includes(String(input.action)) && !entry)
		throw new Error("Memory changed; refresh and try again.")
	if (input.action === "edit" && entry) {
		const patch = input.patch as Record<string, unknown>
		if (!patch || typeof patch !== "object") throw new Error("An edit is required")
		await store.edit(cwd, entry.id, {
			text: typeof patch.text === "string" && patch.text.trim() ? patch.text : entry.text,
			pinned: typeof patch.pinned === "boolean" ? patch.pinned : entry.pinned,
			importance: patch.importance === "high" || patch.importance === "normal" ? patch.importance : entry.importance,
			type: patch.type === "" ? undefined : (MEMORY_TYPES.find((type) => type === patch.type) ?? entry.type),
		})
	}
	if (input.action === "delete" && entry) await store.remove(cwd, entry.scope, { texts: [entry.text], topicFiles: [] })
	if (input.action === "move" && entry) await store.move(cwd, entry.id, scope(input.scope))
	if (input.action === "promote" && entry) {
		const file = await promotionTarget(cwd)
		const current = await fs.readFile(file, "utf8").catch(() => "# Repository instructions\n")
		let text = entry.text.replace(/ \(details: [^)]+\)$/, "")
		if (entry.topicFile) {
			if (!/^[a-z0-9._-]+\.md$/i.test(entry.topicFile) || entry.topicFile.startsWith("."))
				throw new Error("Invalid memory topic file")
			const source = store.fileFor(await store.locate(cwd), entry.scope)
			text += `\n\n${await fs.readFile(path.join(path.dirname(source), entry.topicFile), "utf8")}`
		}
		await openMemoryPromotionDraft(file, current, text)
	}
	if (input.action === "finishPromotion" && entry) {
		const file = await promotionTarget(cwd)
		if (!(await fs.readFile(file, "utf8")).includes(entry.text.replace(/ \(details: [^)]+\)$/, "")))
			throw new Error("Save the reviewed convention to AGENTS.md before finishing its promotion.")
		await store.remove(cwd, entry.scope, { texts: [entry.text], topicFiles: [] })
	}
	if (input.action === "resolve")
		await coordinator.resolveProposal(
			String(input.proposalId),
			input.save === true,
			Array.isArray(input.itemIds) ? input.itemIds.filter((id): id is string => typeof id === "string") : [],
		)
	if (input.action === "undo") await coordinator.undo(String(input.proposalId), String(input.itemId))
	if (input.action === "cleanup") await coordinator.cleanupNow()
	if (input.action === "adopt") await store.adopt(cwd, String(input.key))
	if (input.action === "settings") {
		if (typeof input.budget === "string" || typeof input.budget === "number") await setMemoryBudget(input.budget)
		if (typeof input.distill === "string") await setMemoryDistillMode(input.distill)
		if (input.tuning && typeof input.tuning === "object") await setMemoryTuning(input.tuning as Partial<MemoryTuning>)
	}
	const selection = conversationId ? snapshots.get(conversationId) : undefined
	return {
		entries: await store.entries(cwd),
		pending: await coordinator.inbox(cwd),
		budget: getMemoryBudget(),
		distill: getMemoryDistillMode(),
		tuning: getMemoryTuning(),
		group: (await store.locate(cwd)).group,
		adoption: await store.adoptionCandidates(cwd),
		usage: await store.usage(cwd),
		selection: selection
			? {
					text: selection.text,
					relevant: selection.relevant,
					tokens: Math.ceil(selection.summary.chars / 3),
					budget: selection.budget,
					loaded: selection.loaded.map(({ entry, tier }) => ({ id: entry.id, tier })),
					cut: selection.cut,
				}
			: undefined,
	}
}
