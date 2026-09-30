import { ProviderModelsResponse, ResolveProviderModelsRequest } from "@/shared/proto/cline/models"
import { Logger } from "@/shared/services/Logger"
import { pruneFavoriteModels } from "../state/pruneFavoriteModels"
import { type ProviderCatalogController, parseProviderIdRequest, toProviderModelsResponse } from "./providerCatalogShared"

export async function resolveProviderModels(
	controller: ProviderCatalogController,
	request: ResolveProviderModelsRequest,
): Promise<ProviderModelsResponse> {
	const providerId = parseProviderIdRequest(request.providerId)
	const requestId = request.requestId?.trim() || crypto.randomUUID()
	const result = await controller.getProviderCatalog().resolveModels(providerId, { forceRefresh: request.forceRefresh })
	await dropFavoritesMissingFromCatalog(controller, result)
	return toProviderModelsResponse(providerId, requestId, result)
}

async function dropFavoritesMissingFromCatalog(
	controller: ProviderCatalogController,
	result: Parameters<typeof pruneFavoriteModels>[1],
): Promise<void> {
	const candidate = controller as ProviderCatalogController & {
		stateManager?: Parameters<typeof pruneFavoriteModels>[0]
		postStateToWebview?: () => Promise<void>
	}
	if (typeof candidate.stateManager?.reloadGlobalStateKey !== "function") {
		return
	}
	try {
		if (pruneFavoriteModels(candidate.stateManager, result)) {
			await candidate.postStateToWebview?.()
		}
	} catch (error) {
		Logger.error("Failed to drop favorite models missing from the catalog:", error)
	}
}
