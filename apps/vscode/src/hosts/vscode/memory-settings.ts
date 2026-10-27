import { DEFAULT_MEMORY_TUNING, type MemoryTuning } from "@shared/memory"
import { memoryBudgetTokens, parseMemoryBudget } from "@shared/memory-budget"
import * as vscode from "vscode"

/** VS Code settings section that holds every `plinycode.memory.*` setting. */
const MEMORY_SETTINGS_SECTION = "plinycode.memory"

const DEFAULT_MEMORY_MAX_TOKENS = "auto"
/** The Settings view's upper bound: past this, memory crowds out the conversation on small-context models. */
const MAX_MEMORY_MAX_TOKENS = 64_000

function read<T>(setting: string, fallback: T): T {
	try {
		return vscode.workspace.getConfiguration(MEMORY_SETTINGS_SECTION).get<T>(setting, fallback) ?? fallback
	} catch {
		// Hosts without VS Code's configuration API keep the default.
		return fallback
	}
}

/** Stored in the user's VS Code settings, so it persists and follows Settings Sync. */
async function write(setting: string, value: unknown): Promise<void> {
	await vscode.workspace.getConfiguration(MEMORY_SETTINGS_SECTION).update(setting, value, vscode.ConfigurationTarget.Global)
}

/**
 * `plinycode.memory.maxTokens`: how much of the repository and user memory
 * goes into the system prompt. 0 turns memory off: no section and no
 * save_memory tool. See sdk/memory/ and docs/memory.md.
 */
export function getMemoryBudget(): string | number {
	return read<string | number>("maxTokens", DEFAULT_MEMORY_MAX_TOKENS)
}

/** `plinycode.memory.enabled`: master switch for repository memory in the prompt and memory tools. */
export function isMemoryUseEnabled(): boolean {
	return read<boolean>("enabled", true) !== false
}

export function getMemoryMaxTokens(contextWindow = 100_000): number {
	if (!isMemoryUseEnabled()) {
		return 0
	}
	return memoryBudgetTokens(getMemoryBudget(), contextWindow)
}

export async function setMemoryUseEnabled(enabled: boolean): Promise<void> {
	await write("enabled", enabled)
}

export async function setMemoryBudget(value: string | number): Promise<void> {
	value = typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, "") : value
	if (!parseMemoryBudget(value)) throw new Error("Enter auto, a token count from 0 to 64000, or a percentage from 0% to 100%.")
	await write("maxTokens", value)
}

export function getMemoryTuning(): MemoryTuning {
	const result = { ...DEFAULT_MEMORY_TUNING }
	for (const key of Object.keys(result) as (keyof MemoryTuning)[]) {
		const value = Number(read(key, result[key]))
		if (Number.isFinite(value) && value >= (key === "userShare" ? 0 : 1) && value <= (key === "userShare" ? 100 : 1000))
			result[key] = Math.floor(value)
	}
	return result
}

export async function setMemoryTuning(patch: Partial<MemoryTuning>): Promise<void> {
	for (const key of Object.keys(DEFAULT_MEMORY_TUNING) as (keyof MemoryTuning)[]) {
		const value = patch[key]
		if (value === undefined) continue
		if (!Number.isInteger(value) || value < (key === "userShare" ? 0 : 1) || value > (key === "userShare" ? 100 : 1000))
			throw new Error(`Invalid memory setting: ${key}`)
		await write(key, value)
	}
}

export function getMemoryDistillMode(): "off" | "offer" | "auto" {
	const value = read<string>("distill", "offer")
	return value === "auto" || value === "off" ? value : "offer"
}

export async function setMemoryDistillMode(value: string): Promise<void> {
	if (!["off", "offer", "auto"].includes(value)) throw new Error("Invalid distillation mode")
	await write("distill", value)
}

export async function setMemoryMaxTokens(tokens: number): Promise<void> {
	if (!Number.isFinite(tokens) || tokens < 0 || tokens > MAX_MEMORY_MAX_TOKENS) {
		throw new Error(`Invalid memory budget: ${tokens}`)
	}
	await write("maxTokens", Math.floor(tokens))
}

/** `plinycode.memory.distill`: offer memories to save after an act-mode run that edited files. */
export function isMemoryDistillOfferEnabled(): boolean {
	return getMemoryMaxTokens() > 0 && read<string>("distill", "offer") !== "off"
}

export async function setMemoryDistillOfferEnabled(enabled: boolean): Promise<void> {
	await write("distill", enabled ? "offer" : "off")
}

/** `plinycode.memory.conversationSearch`: give the model the search_conversations and read_conversation tools. */
export function isConversationSearchEnabled(): boolean {
	return read<boolean>("conversationSearch", true) !== false
}

export async function setConversationSearchEnabled(enabled: boolean): Promise<void> {
	await write("conversationSearch", enabled)
}
