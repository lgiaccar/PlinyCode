import type { EmptyRequest } from "@shared/proto/cline/common"
import type { RouterSettingsResponse } from "@shared/proto/cline/models"
import { type RouterSettingsController, routerSettingsResponse } from "./router-settings-view"

/** Settings → Router: each router profile's rules-file defaults, its tuning and the models it may use. */
export async function getRouterSettings(
	controller: RouterSettingsController,
	_request: EmptyRequest,
): Promise<RouterSettingsResponse> {
	return routerSettingsResponse(controller)
}
