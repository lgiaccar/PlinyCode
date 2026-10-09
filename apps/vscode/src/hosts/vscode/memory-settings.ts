import * as vscode from "vscode"

/** VS Code settings section that holds every `plinycode.memory.*` setting. */
const MEMORY_SETTINGS_SECTION = "plinycode.memory"

const DEFAULT_MEMORY_MAX_TOKENS = 4000
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
export function getMemoryMaxTokens(): number {
	const value = Number(read<number>("maxTokens", DEFAULT_MEMORY_MAX_TOKENS))
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

export async function setMemoryMaxTokens(tokens: number): Promise<void> {
	if (!Number.isFinite(tokens) || tokens < 0 || tokens > MAX_MEMORY_MAX_TOKENS) {
		throw new Error(`Invalid memory budget: ${tokens}`)
	}
	await write("maxTokens", Math.floor(tokens))
}

/** `plinycode.memory.distill`: offer memories to save after an act-mode run that edited files. */
export function isMemoryDistillOfferEnabled(): boolean {
	return read<string>("distill", "offer") !== "off"
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
