import * as vscode from "vscode"

/** VS Code settings section that holds every `plinycode.compaction.*` setting. */
const COMPACTION_SETTINGS_SECTION = "plinycode.compaction"
const THRESHOLD_SETTING = "threshold"

/** Where auto-condense runs by default: the engine's COMPACTION_TRIGGER_RATIO. */
const DEFAULT_COMPACTION_THRESHOLD = 0.9
const MIN_COMPACTION_THRESHOLD = 0.1
const MAX_COMPACTION_THRESHOLD = 0.95

/**
 * `plinycode.compaction.threshold`: the share of the model's input limit at
 * which auto-condense compacts the conversation. Read before every model
 * call (the session factory passes this function to the engine), so a change
 * applies to the running conversation. See docs/context-compaction.md.
 */
export function getCompactionThreshold(): number {
	try {
		const value = Number(
			vscode.workspace
				.getConfiguration(COMPACTION_SETTINGS_SECTION)
				.get<number>(THRESHOLD_SETTING, DEFAULT_COMPACTION_THRESHOLD),
		)
		return Number.isFinite(value)
			? Math.min(MAX_COMPACTION_THRESHOLD, Math.max(MIN_COMPACTION_THRESHOLD, value))
			: DEFAULT_COMPACTION_THRESHOLD
	} catch {
		// Hosts without VS Code's configuration API keep the default.
		return DEFAULT_COMPACTION_THRESHOLD
	}
}

/** Stored in the user's VS Code settings, so it persists and follows Settings Sync. */
export async function setCompactionThreshold(threshold: number): Promise<void> {
	if (!Number.isFinite(threshold) || threshold < MIN_COMPACTION_THRESHOLD || threshold > MAX_COMPACTION_THRESHOLD) {
		throw new Error(`Invalid compaction threshold: ${threshold}`)
	}
	await vscode.workspace
		.getConfiguration(COMPACTION_SETTINGS_SECTION)
		.update(THRESHOLD_SETTING, Math.round(threshold * 1000) / 1000, vscode.ConfigurationTarget.Global)
}
