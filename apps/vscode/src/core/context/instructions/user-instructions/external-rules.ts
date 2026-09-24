import { combineRuleToggles, synchronizeRuleToggles } from "@core/context/instructions/user-instructions/rule-helpers"
import { GlobalFileNames } from "@core/storage/disk"
import { resolveExternalWorkspaceRulesConfigPaths } from "@plinycode/shared/storage"
import { ClineRulesToggles } from "@shared/cline-rules"
import path from "path"
import { Controller } from "@/core/controller"

/**
 * Synchronizes toggles for every rule location of one tool. Directories are
 * scanned once per accepted extension; `synchronizeRuleToggles` prunes toggles
 * outside what it scanned, so every pass starts from the same state and the
 * results are combined.
 */
async function synchronizeExternalToggles(
	locations: string[],
	currentToggles: ClineRulesToggles,
	directoryExtensions: string[],
): Promise<ClineRulesToggles> {
	let combined: ClineRulesToggles = {}
	for (const location of locations) {
		for (const extension of directoryExtensions) {
			combined = combineRuleToggles(combined, await synchronizeRuleToggles(location, currentToggles, extension))
		}
	}
	return combined
}

/**
 * Refreshes the toggles for rules written for other agents (GitHub Copilot,
 * Cursor, Windsurf) and the workspace AGENTS.md. The locations come from the
 * same shared resolver the SDK runtime loads rules from, so the Rules panel
 * lists exactly what can reach the model. New files start enabled, like any
 * other workspace rule.
 */
export async function refreshExternalRulesToggles(
	controller: Controller,
	workingDirectory: string,
): Promise<{
	windsurfLocalToggles: ClineRulesToggles
	cursorLocalToggles: ClineRulesToggles
	agentsLocalToggles: ClineRulesToggles
	copilotLocalToggles: ClineRulesToggles
}> {
	const external = resolveExternalWorkspaceRulesConfigPaths(workingDirectory)

	const updatedLocalWindsurfToggles = await synchronizeExternalToggles(
		external.windsurf,
		controller.stateManager.getWorkspaceStateKey("localWindsurfRulesToggles"),
		[""],
	)
	controller.stateManager.setWorkspaceState("localWindsurfRulesToggles", updatedLocalWindsurfToggles)

	// Cursor: `.cursor/rules/**/*.mdc` (and plain `.md`) plus the legacy `.cursorrules` file.
	const updatedLocalCursorToggles = await synchronizeExternalToggles(
		external.cursor,
		controller.stateManager.getWorkspaceStateKey("localCursorRulesToggles"),
		[".mdc", ".md"],
	)
	controller.stateManager.setWorkspaceState("localCursorRulesToggles", updatedLocalCursorToggles)

	// GitHub Copilot: `.github/copilot-instructions.md` plus `.github/instructions/**/*.instructions.md`.
	const updatedLocalCopilotToggles = await synchronizeExternalToggles(
		external.copilot,
		controller.stateManager.getWorkspaceStateKey("localCopilotRulesToggles"),
		[".md"],
	)
	controller.stateManager.setWorkspaceState("localCopilotRulesToggles", updatedLocalCopilotToggles)

	const localAgentsRulesFilePath = path.resolve(workingDirectory, GlobalFileNames.agentsRulesFile)
	const updatedLocalAgentsToggles = await synchronizeRuleToggles(
		localAgentsRulesFilePath,
		controller.stateManager.getWorkspaceStateKey("localAgentsRulesToggles"),
	)
	controller.stateManager.setWorkspaceState("localAgentsRulesToggles", updatedLocalAgentsToggles)

	return {
		windsurfLocalToggles: updatedLocalWindsurfToggles,
		cursorLocalToggles: updatedLocalCursorToggles,
		agentsLocalToggles: updatedLocalAgentsToggles,
		copilotLocalToggles: updatedLocalCopilotToggles,
	}
}
