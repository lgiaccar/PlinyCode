/**
 * Feature flags — static no-op implementation for PlinyCode.
 *
 * PlinyCode is an internal Synopsys extension. The upstream PostHog-backed
 * feature-flag infrastructure is not deployed here. All flags default to the
 * values defined in FeatureFlagDefaultValue, and the service API is preserved
 * so callers don't need to change.
 */
export { FeatureFlagsService } from "./FeatureFlagsService"

import { type FeatureFlag, FeatureFlagDefaultValue } from "@/shared/services/feature-flags/feature-flags"
import { FeatureFlagsService } from "./FeatureFlagsService"
import type { FeatureFlagsAndPayloads } from "./providers/IFeatureFlagsProvider"

/** No-op provider: always returns configured defaults, never hits the network. */
class StaticFeatureFlagsProvider {
	async getAllFlagsAndPayloads(_: { flagKeys?: string[] }): Promise<FeatureFlagsAndPayloads | undefined> {
		return {}
	}

	isEnabled(): boolean {
		return true
	}

	getSettings() {
		return { enabled: true, timeout: 1000 }
	}

	async dispose(): Promise<void> {}
}

let _featureFlagsServiceInstance: FeatureFlagsService | null = null

/**
 * Get the singleton feature flags service instance (always a static no-op).
 */
export function getFeatureFlagsService(): FeatureFlagsService {
	if (!_featureFlagsServiceInstance) {
		_featureFlagsServiceInstance = new FeatureFlagsService(new StaticFeatureFlagsProvider())
		// Pre-populate cache with defaults so getBooleanFlagEnabled / getFlagPayload
		// return the right values without an async poll.
		for (const [flag, value] of Object.entries(FeatureFlagDefaultValue)) {
			if (value !== undefined) {
				;(_featureFlagsServiceInstance as any).cache.set(flag as FeatureFlag, value)
			}
		}
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
