import { parsePlanExecutionChoice } from "@shared/planExecution"
import { Boolean } from "@shared/proto/cline/common"
import { PlanActMode, TogglePlanActModeRequest } from "@shared/proto/cline/state"
import { Mode } from "@shared/storage/types"
import { preparePlanExecution } from "@/sdk/plan-execution"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Switches to Plan, Act or Ask mode
 * @param controller The controller instance
 * @param request The request containing the chat settings and optional chat content
 * @returns An empty response
 */
export async function togglePlanActModeProto(controller: Controller, request: TogglePlanActModeRequest): Promise<Boolean> {
	try {
		let mode: Mode
		if (request.mode === PlanActMode.PLAN) {
			mode = "plan"
		} else if (request.mode === PlanActMode.ACT) {
			mode = "act"
		} else if (request.mode === PlanActMode.ASK_MODE) {
			mode = "ask"
		} else {
			throw new Error(`Invalid mode value: ${request.mode}`)
		}
		const chatContent = request.chatContent

		// Execute plan can name the model to run the plan on. Only for a real
		// plan -> act switch: when the mode is already act the toggle below does
		// nothing, and changing the model would retarget the session that is running.
		const executePlanWith = mode === "act" ? parsePlanExecutionChoice(request.executePlanWith) : undefined
		if (executePlanWith && controller.stateManager.getGlobalSettingsKey("mode") === "plan") {
			await preparePlanExecution(controller, executePlanWith)
		}

		// Call the existing controller implementation
		const sentMessage = await controller.togglePlanActMode(mode, chatContent)

		return Boolean.create({
			value: sentMessage,
		})
	} catch (error) {
		Logger.error("Failed to toggle Plan/Act mode:", error)
		throw error
	}
}
