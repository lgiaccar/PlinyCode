import { ClineRulesToggles } from "@shared/cline-rules"
import path from "path"

type RuleToggleSource = {
	getGlobalSettingsKey(key: "globalClineRulesToggles"): ClineRulesToggles
	getWorkspaceStateKey(
		key:
			| "localClineRulesToggles"
			| "localCursorRulesToggles"
			| "localWindsurfRulesToggles"
			| "localAgentsRulesToggles"
			| "localCopilotRulesToggles",
	): ClineRulesToggles
}

function normalizeRulePath(filePath: string): string {
	const resolved = path.resolve(filePath)
	// Windows paths are case-insensitive and the drive letter casing differs
	// between VS Code ("d:\\") and Node ("D:\\").
	return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/**
 * Build the predicate the SDK runtime uses to drop rules the user switched off
 * in the Rules panel. The SDK discovers rule files itself and has no notion of
 * these toggles, so without it every discovered rule reached the model no
 * matter what the panel showed. Toggles are re-read on every call, so a change
 * applies the next time a system prompt is built.
 */
export function createRuleFileFilter(stateManager: RuleToggleSource): (filePath: string) => boolean {
	return (filePath) => {
		const toggleMaps = [
			stateManager.getGlobalSettingsKey("globalClineRulesToggles"),
			stateManager.getWorkspaceStateKey("localClineRulesToggles"),
			stateManager.getWorkspaceStateKey("localCursorRulesToggles"),
			stateManager.getWorkspaceStateKey("localWindsurfRulesToggles"),
			stateManager.getWorkspaceStateKey("localAgentsRulesToggles"),
			stateManager.getWorkspaceStateKey("localCopilotRulesToggles"),
		]
		const target = normalizeRulePath(filePath)
		return !toggleMaps.some((toggles) =>
			Object.entries(toggles ?? {}).some(
				([rulePath, enabled]) => enabled === false && normalizeRulePath(rulePath) === target,
			),
		)
	}
}
