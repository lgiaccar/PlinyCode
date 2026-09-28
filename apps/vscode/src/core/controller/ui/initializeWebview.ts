import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import { refreshWorkflowToggles } from "@/core/context/instructions/user-instructions/workflows"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { getCwd, getDesktopDir } from "@/utils/path"
import type { Controller } from "../index"

/**
 * Initialize webview when it launches
 * @param controller The controller instance
 * @param request The empty request
 * @returns Empty response
 */
export async function initializeWebview(controller: Controller, _request: EmptyRequest): Promise<Empty> {
	try {
		// The webview calls this once on mount, on every host. The VS Code-only
		// "sidebar_resolved"/"sidebar_visible" sources never fire for JetBrains, so
		// this is the only host-neutral signal that the Cline UI actually rendered.
		telemetryService.capturePanelOpened("webview_initialized")

		// Sync workflow toggles with the files on disk so the chat input's slash
		// command menu knows about workflows without requiring the user to open
		// the Workflows modal first (which is the only other place that refreshes
		// them). Fire-and-forget: the state post makes the toggles reach the webview.
		getCwd(getDesktopDir())
			.then(async (cwd) => {
				await refreshWorkflowToggles(controller, cwd)
				await controller.postStateToWebview()
			})
			.catch((error) => Logger.warn("Failed to refresh workflow toggles on webview launch:", error))

		// Initialize telemetry service with user's current setting
		controller.getStateToPostToWebview().then((state) => {
			const { telemetrySetting } = state
			const isOptedIn = telemetrySetting !== "disabled"
			telemetryService.updateTelemetryState(isOptedIn)
		})

		return Empty.create({})
	} catch (error) {
		Logger.error("Failed to initialize webview:", error)
		// Return empty response even on error to not break the frontend
		return Empty.create({})
	}
}
