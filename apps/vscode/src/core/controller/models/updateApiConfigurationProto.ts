import { Empty } from "@shared/proto/cline/common"
import type { UpdateApiConfigurationRequest } from "@shared/proto/cline/models"
import { convertProtoToApiProvider } from "@shared/proto-conversions/models/api-configuration-conversion"
import { OpenaiReasoningEffort } from "@shared/storage/types"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"
import { resolveActiveModelIdFromApiConfiguration } from "./taskApiModel"

/**
 * Updates API configuration
 * @param controller The controller instance
 * @param request The update API configuration request
 * @returns Empty response
 */
export async function updateApiConfigurationProto(
	controller: Controller,
	request: UpdateApiConfigurationRequest,
): Promise<Empty> {
	try {
		if (!request.apiConfiguration) {
			Logger.log("[APICONFIG: updateApiConfigurationProto] API configuration is required")
			throw new Error("API configuration is required")
		}

		const protoApiConfiguration = request.apiConfiguration

		const convertedApiConfigurationFromProto = {
			...protoApiConfiguration,
			// Provider ids arrive as plain strings; anything but Pliny reads as Pliny.
			planModeApiProvider:
				protoApiConfiguration.planModeApiProvider !== undefined
					? convertProtoToApiProvider(protoApiConfiguration.planModeApiProvider)
					: undefined,
			actModeApiProvider:
				protoApiConfiguration.actModeApiProvider !== undefined
					? convertProtoToApiProvider(protoApiConfiguration.actModeApiProvider)
					: undefined,

			planModeReasoningEffort: protoApiConfiguration.planModeReasoningEffort as OpenaiReasoningEffort | undefined,
			actModeReasoningEffort: protoApiConfiguration.actModeReasoningEffort as OpenaiReasoningEffort | undefined,
		}

		// Update the API configuration in storage
		controller.stateManager.setApiConfiguration(convertedApiConfigurationFromProto)

		// Update the task's API handler if there's an active task
		if (controller.activeTaskId) {
			const currentMode = controller.stateManager.getGlobalSettingsKey("mode")
			const modelId = resolveActiveModelIdFromApiConfiguration(convertedApiConfigurationFromProto, currentMode)
			controller.setActiveTaskModelId(modelId)
		}

		// Post updated state to webview
		await controller.postStateToWebview()

		return Empty.create()
	} catch (error) {
		Logger.error(`Failed to update API configuration: ${error}`)
		throw error
	}
}
