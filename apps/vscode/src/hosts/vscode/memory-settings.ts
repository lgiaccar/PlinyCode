import * as vscode from "vscode"

/** VS Code settings section that holds every `plinycode.memory.*` setting. */
const MEMORY_SETTINGS_SECTION = "plinycode.memory"

const DEFAULT_MEMORY_MAX_TOKENS = 4000

function read<T>(setting: string, fallback: T): T {
	try {
		return vscode.workspace.getConfiguration(MEMORY_SETTINGS_SECTION).get<T>(setting, fallback) ?? fallback
	} catch {
		// Hosts without VS Code's configuration API keep the default.
		return fallback
	}
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

/** `plinycode.memory.distill`: offer memories to save after an act-mode run that edited files. */
export function isMemoryDistillOfferEnabled(): boolean {
	return read<string>("distill", "offer") !== "off"
}

/** `plinycode.memory.conversationSearch`: give the model the search_conversations and read_conversation tools. */
export function isConversationSearchEnabled(): boolean {
	return read<boolean>("conversationSearch", true) !== false
}
