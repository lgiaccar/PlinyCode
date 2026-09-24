import type { ToggleCopilotRuleRequest } from "@shared/proto/cline/file"
import { ClineRulesToggles } from "@shared/proto/cline/file"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Toggles a GitHub Copilot instructions file (enable or disable)
 * @param controller The controller instance
 * @param request The toggle request
 * @returns The updated Copilot rule toggles
 */
export async function toggleCopilotRule(controller: Controller, request: ToggleCopilotRuleRequest): Promise<ClineRulesToggles> {
	const { rulePath, enabled } = request

	if (!rulePath || typeof enabled !== "boolean") {
		Logger.error("toggleCopilotRule: Missing or invalid parameters", {
			rulePath,
			enabled: typeof enabled === "boolean" ? enabled : `Invalid: ${typeof enabled}`,
		})
		throw new Error("Missing or invalid parameters for toggleCopilotRule")
	}

	// Update the toggles in workspace state
	const toggles = controller.stateManager.getWorkspaceStateKey("localCopilotRulesToggles")
	toggles[rulePath] = enabled
	controller.stateManager.setWorkspaceState("localCopilotRulesToggles", toggles)

	// Get the current state to return in the response
	const copilotToggles = controller.stateManager.getWorkspaceStateKey("localCopilotRulesToggles")

	return ClineRulesToggles.create({
		toggles: copilotToggles,
	})
}
