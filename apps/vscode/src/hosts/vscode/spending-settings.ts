import * as vscode from "vscode"

/** VS Code settings section that holds every `plinycode.spending.*` setting. */
export const SPENDING_SETTINGS_SECTION = "plinycode.spending"

/** `plinycode.spending.conversationLimit`: USD a conversation may spend before PlinyCode pauses it. */
export const CONVERSATION_LIMIT_SETTING = "conversationLimit"

export const DEFAULT_CONVERSATION_SPENDING_LIMIT = 5

/**
 * The per-conversation spending limit in USD; 0 turns the limit off. Stored
 * in the user's VS Code settings, so it persists and follows Settings Sync.
 */
export function getConversationSpendingLimit(): number {
	try {
		const value = vscode.workspace
			.getConfiguration(SPENDING_SETTINGS_SECTION)
			.get<number>(CONVERSATION_LIMIT_SETTING, DEFAULT_CONVERSATION_SPENDING_LIMIT)
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_CONVERSATION_SPENDING_LIMIT
	} catch {
		// Hosts without VS Code's configuration API (standalone) keep the default.
		return DEFAULT_CONVERSATION_SPENDING_LIMIT
	}
}

export async function setConversationSpendingLimit(limit: number): Promise<void> {
	if (!Number.isFinite(limit) || limit < 0) {
		throw new Error(`Invalid conversation spending limit: ${limit}`)
	}
	await vscode.workspace
		.getConfiguration(SPENDING_SETTINGS_SECTION)
		.update(CONVERSATION_LIMIT_SETTING, limit, vscode.ConfigurationTarget.Global)
}
