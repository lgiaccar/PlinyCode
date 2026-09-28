import { getProviderCollectionSync } from "@plinycode/llms"
import { SettingsKey } from "@shared/storage/state-keys"
import { toSdkProviderId } from "@/sdk/model-catalog/sdk-provider-id"
import type { ApiProvider } from "../api"

/**
 * The state key holding the mode's model id. Pliny, the only provider, uses
 * the generic `*ModeApiModelId` key.
 */
export function getProviderModelIdKey(_provider: ApiProvider | string, mode: "act" | "plan"): SettingsKey {
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
