import { getProviderCollectionSync } from "@plinycode/llms"
import { SettingsKey } from "@shared/storage/state-keys"
import { toSdkProviderId } from "@/sdk/model-catalog/sdk-provider-id"
import type { ApiProvider } from "../api"

// Providers that keep their model id in a provider-specific state key. Pliny
// uses the generic `*ModeApiModelId` key; the others remain until the Cline
// account and OCA plumbing that still names them is gone.
const ProviderKeyMap: Partial<Record<ApiProvider, string>> = {
	cline: "ClineModelId",
	"cline-pass": "ClinePassModelId",
	oca: "OcaModelId",
} as const

/**
 * Get the provider-specific model ID key for a given provider and mode.
 */
export function getProviderModelIdKey(provider: ApiProvider | string, mode: "act" | "plan"): SettingsKey {
	const keySuffix = ProviderKeyMap[provider as ApiProvider]
	if (keySuffix) {
		// E.g. actModeClineModelId, planModeClineModelId, etc.
		return `${mode}Mode${keySuffix}` as SettingsKey
	}

	return `${mode}ModeApiModelId`
}

/**
 * Resolve the provider's default model id from the SDK catalog, or an empty
 * string when the SDK has no entry for `provider`.
 */
export function getProviderDefaultModelId(provider: ApiProvider | string): string | null {
	const collection = getProviderCollectionSync(toSdkProviderId(provider))
	return collection?.provider.defaultModelId ?? ""
}
