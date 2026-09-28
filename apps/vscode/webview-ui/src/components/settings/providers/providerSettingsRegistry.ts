import type { ProviderListing } from "@shared/proto/cline/models"
import type { GenericProviderSettingsProps } from "./GenericProviderSettings"

type GenericProviderSettingsConfig = Omit<GenericProviderSettingsProps, "currentMode" | "isPopup" | "showModelOptions">

type GenericProviderPresentationOverride = Pick<GenericProviderSettingsConfig, "signupUrl" | "baseUrlField"> &
	Partial<Pick<GenericProviderSettingsConfig, "allowsCustomIds">>

const GENERIC_PROVIDER_PRESENTATION_OVERRIDES: Record<string, GenericProviderPresentationOverride> = {
	pliny: {
		// Base URL is fixed on the builtin; leave the field hidden so users
		// don't point the picker at a wrong endpoint. Auth falls through to
		// PLINY_API_KEY when the UI key is empty.
	},
}

const GENERIC_PROVIDER_PROTOCOLS = new Set(["anthropic", "gemini", "openai-chat", "openai-responses"])

const FALLBACK_GENERIC_PROVIDER_NAMES = {
	pliny: "Pliny",
} as const

export function isGenericProviderListing(listing: ProviderListing | undefined): listing is ProviderListing {
	return Boolean(listing?.name) && GENERIC_PROVIDER_PROTOCOLS.has(listing?.protocol ?? "")
}

/**
 * Settings form for a provider the SDK lists, with the presentation overrides
 * applied.
 */
export function getGenericProviderSettings(
	providerId: string,
	listing?: ProviderListing,
): GenericProviderSettingsConfig | undefined {
	if (!isGenericProviderListing(listing) || listing.id !== providerId) {
		return undefined
	}

	const overrides = GENERIC_PROVIDER_PRESENTATION_OVERRIDES[providerId]

	return {
		...overrides,
		allowsCustomIds: overrides?.allowsCustomIds ?? listing.allowsCustomModelIds,
		providerId: listing.id,
		providerName: listing.name,
	}
}

/**
 * Settings form to show before the SDK provider listing has arrived.
 */
export function getFallbackGenericProviderSettings(providerId: string): GenericProviderSettingsConfig | undefined {
	const providerName = FALLBACK_GENERIC_PROVIDER_NAMES[providerId as keyof typeof FALLBACK_GENERIC_PROVIDER_NAMES]
	if (!providerName) {
		return undefined
	}

	const overrides = GENERIC_PROVIDER_PRESENTATION_OVERRIDES[providerId]

	return {
		...overrides,
		allowsCustomIds: overrides?.allowsCustomIds ?? false,
		providerId,
		providerName,
	}
}
