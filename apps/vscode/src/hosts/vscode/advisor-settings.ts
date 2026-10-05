import * as vscode from "vscode"
import { type AdvisorSettings, DEFAULT_ADVISOR_SETTINGS, normalizeAdvisorSettings } from "@/sdk/advisor/advisor-settings"

/** VS Code settings section that holds every `plinycode.advisor.*` setting. */
const ADVISOR_SETTINGS_SECTION = "plinycode.advisor"

/**
 * The `plinycode.advisor.*` settings: when the `ask_advisor` tool is offered,
 * which model answers, and how many calls a conversation gets. Read on every
 * use, so a change applies to running conversations; see sdk/advisor/.
 */
export function getAdvisorSettings(): AdvisorSettings {
	try {
		const config = vscode.workspace.getConfiguration(ADVISOR_SETTINGS_SECTION)
		return normalizeAdvisorSettings({
			use: config.get("use"),
			model: config.get("model"),
			maxCallsPerConversation: config.get("maxCallsPerConversation"),
		})
	} catch {
		// Hosts without VS Code's configuration API (standalone) keep the defaults.
		return DEFAULT_ADVISOR_SETTINGS
	}
}
