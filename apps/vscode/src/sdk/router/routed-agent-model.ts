import { createRoutedAgentModel as createSharedModel, type RoutedAgentModelDeps } from "@plinycode/core/pliny-router"
import { Logger } from "@/shared/services/Logger"

export { isDegenerateOutputError, type RoutedAgentModelDeps, type RouterObserver } from "@plinycode/core/pliny-router"
export function createRoutedAgentModel(deps: RoutedAgentModelDeps) {
	return createSharedModel({ ...deps, logWarning: (message) => Logger.warn(message) })
}
