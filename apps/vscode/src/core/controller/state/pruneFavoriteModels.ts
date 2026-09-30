import type { ProviderModelsResult } from "@/sdk/model-catalog/contracts"
import { canonicalPlinyModelId, PLINY_PROVIDER_ID } from "@/shared/pliny"

interface FavoritesStateManager {
	reloadGlobalStateKey(key: "favoritedModelIds"): string[]
	setGlobalState(key: "favoritedModelIds", value: string[]): void
}

/**
 * Favorites are global and kept across restarts; a favorite goes only once the
 * Pliny catalog, fetched successfully from the gateway, no longer has its model.
 * A failed, empty or bundled (offline) catalog never removes anything. Router
 * ids from before the `auto-*` rename are carried over to their current id.
 *
 * @returns whether the stored favorites changed
 */
export function pruneFavoriteModels(stateManager: FavoritesStateManager, result: ProviderModelsResult): boolean {
	if (
		result.providerId !== PLINY_PROVIDER_ID ||
		!result.ok ||
		result.models.size === 0 ||
		(result.source !== "sdk-dynamic" && result.source !== "extension-dynamic")
	) {
		return false
	}
	const favorites = stateManager.reloadGlobalStateKey("favoritedModelIds") ?? []
	const kept = [...new Set(favorites.map((id) => (result.models.has(id) ? id : canonicalPlinyModelId(id))))].filter((id) =>
		result.models.has(id),
	)
	if (kept.length === favorites.length && kept.every((id, index) => id === favorites[index])) {
		return false
	}
	stateManager.setGlobalState("favoritedModelIds", kept)
	return true
}
