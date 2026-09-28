export { FeatureFlagsService } from "./FeatureFlagsService"

import { FeatureFlagsService } from "./FeatureFlagsService"
import { NoOpFeatureFlagsProvider } from "./providers/NoOpFeatureFlagsProvider"

let _featureFlagsServiceInstance: FeatureFlagsService | null = null

/**
 * Get the singleton feature flags service instance
 * @param distinctId Optional distinct ID for the feature flags provider
 * @returns FeatureFlagsService instance
 */
export function getFeatureFlagsService(): FeatureFlagsService {
	if (!_featureFlagsServiceInstance) {
		_featureFlagsServiceInstance = new FeatureFlagsService(new NoOpFeatureFlagsProvider())
	}
	return _featureFlagsServiceInstance
}

export const featureFlagsService = new Proxy({} as FeatureFlagsService, {
	get(_target, prop, _receiver) {
		const service = getFeatureFlagsService()
		const value = Reflect.get(service, prop, service)
		// Bind methods to the service instance to preserve `this` context
		if (typeof value === "function") {
			return value.bind(service)
		}
		return value
	},
})
