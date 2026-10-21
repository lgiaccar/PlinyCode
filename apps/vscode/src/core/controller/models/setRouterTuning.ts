import type { RouterSettingsResponse, SetRouterTuningRequest } from "@shared/proto/cline/models"
import { isRouterTuningProfile, normalizeRouterProfileTuning, type RouterTuningMap } from "@shared/router-tuning"
import { type RouterSettingsController, routerSettingsResponse } from "./router-settings-view"

/**
 * Stores one router profile's tuning, replacing what it had. Invalid fields
 * are dropped, and a tuning with nothing left removes the profile's entry.
 * Sessions read the map on every routed call, so nothing is rebuilt: the next
 * call routes by the new settings.
 */
export async function setRouterTuning(
	controller: RouterSettingsController,
	request: SetRouterTuningRequest,
): Promise<RouterSettingsResponse> {
	const profile = request.profile.trim()
	if (!isRouterTuningProfile(profile)) {
		throw new Error(`Unknown router profile: ${profile}`)
	}
	let raw: unknown
	try {
		raw = request.tuningJson.trim() ? JSON.parse(request.tuningJson) : undefined
	} catch {
		throw new Error("The router tuning is not valid JSON")
	}
	const tuning = normalizeRouterProfileTuning(raw)

	// Another window may have tuned other profiles since this one loaded the map.
	const current: RouterTuningMap = controller.stateManager.reloadGlobalStateKey("routerTuning") ?? {}
	const { [profile]: _previous, ...rest } = current
	const next: RouterTuningMap = tuning ? { ...rest, [profile]: tuning } : rest
	controller.stateManager.setGlobalState("routerTuning", next)
	await controller.postStateToWebview?.()
	return routerSettingsResponse(controller)
}
