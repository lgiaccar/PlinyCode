import type { ApiProvider } from "@shared/api"
import { Logger } from "../../shared/services/Logger"
import type { ProviderId } from "./contracts"

/**
 * Extension-known provider ids. The object is typed against `ApiProvider`
 * so adding/removing an `ApiProvider` member forces this list to update.
 *
 * `parseProviderId` lowercases all ids so config/storage provider names stay
 * portable across extension versions and hosts. SDK calls that require a
 * different spelling normalize at the SDK boundary.
 */
const KNOWN_API_PROVIDERS = {
	pliny: true,
} satisfies Record<ApiProvider, true>

const normalizeProviderId = (raw: string): string => raw.trim().toLowerCase()

const knownProviderIds = new Set(Object.keys(KNOWN_API_PROVIDERS).map(normalizeProviderId))
const warnedUnknownProviderIds = new Set<string>()

/**
 * Parse a raw string into a branded {@link ProviderId}.
 *
 * Behavior:
 * - Trims surrounding whitespace.
 * - Lowercases the id (canonical form used by extension config/storage).
 * - Accepts arbitrary strings so SDK/custom providers are representable.
 * - Emits a one-time warning per non-empty unknown id per process.
 *
 * The single `as ProviderId` cast here is the constructor for the brand
 * and is the allowed boundary cast for this primitive. Do not replicate
 * this cast elsewhere; callers outside this module must obtain a
 * `ProviderId` through this function.
 */
export function parseProviderId(raw: string): ProviderId {
	const normalized = normalizeProviderId(raw)
	if (normalized.length > 0 && !knownProviderIds.has(normalized) && !warnedUnknownProviderIds.has(normalized)) {
		warnedUnknownProviderIds.add(normalized)
		Logger.warn(`[model-catalog] Unknown provider id "${normalized}". Treating as a custom provider.`)
	}
	return normalized as ProviderId
}
