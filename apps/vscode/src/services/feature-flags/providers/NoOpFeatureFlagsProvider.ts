import { Logger } from "@/shared/services/Logger"
import type { FeatureFlagsAndPayloads, IFeatureFlagsProvider } from "./IFeatureFlagsProvider"

/**
 * Feature flags provider that returns no flags, so boolean flags read as off.
 */
export class NoOpFeatureFlagsProvider implements IFeatureFlagsProvider {
	async getAllFlagsAndPayloads(_: { flagKeys?: string[] }): Promise<FeatureFlagsAndPayloads | undefined> {
		return {}
	}

	public isEnabled(): boolean {
		return true
	}

	public getSettings() {
		return {
			enabled: true,
			timeout: 1000,
		}
	}

	public async dispose(): Promise<void> {
		Logger.info("[NoOpFeatureFlagsProvider] Disposing")
	}
}
