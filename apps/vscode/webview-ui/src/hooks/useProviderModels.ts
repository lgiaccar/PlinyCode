import { ResolveProviderModelsRequest } from "@shared/proto/cline/models"
import { useCallback, useEffect, useMemo } from "react"
import {
	filterPlinyModels,
	usePlinyUnlockFreeModels,
	usePlinyUnlockPaidModels,
} from "@/components/settings/utils/plinyModelFilter"
import { type ProviderId, useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"

let providerModelRequestCounter = 0

function createRequestId(): string {
	providerModelRequestCounter += 1
	return `provider-models-${providerModelRequestCounter}`
}

/**
 * Read-only provider model-list hook backed by the unified provider catalog RPC.
 *
 * This hook never writes model selection state; selection commits are owned by
 * useProviderConfig/commitModelSelection.
 */
export function useProviderModels(providerId: ProviderId) {
	const { providerModelsByProvider, startProviderModelsRequest, applyProviderModelsResponse } = useExtensionState()
	const state = providerModelsByProvider?.[providerId]

	const refresh = useCallback(async () => {
		const requestId = createRequestId()
		startProviderModelsRequest(providerId, requestId)
		try {
			const response = await ModelsServiceClient.resolveProviderModels(
				ResolveProviderModelsRequest.create({ providerId, forceRefresh: true, requestId }),
			)
			applyProviderModelsResponse(response)
		} catch (error) {
			applyProviderModelsResponse({
				providerId,
				requestId,
				configFingerprint: "",
				fetchedAt: Date.now(),
				ok: false,
				models: {},
				error: {
					kind: "unknown",
					message: error instanceof Error ? error.message : String(error),
				},
			})
		}
	}, [applyProviderModelsResponse, providerId, startProviderModelsRequest])

	useEffect(() => {
		void refresh()
	}, [refresh])

	// PlinyCode: paid (hosted) and free (self-hosted) Pliny models are each
	// screened behind their own "Unlock Pliny paid/free models" setting,
	// defaulting to off. Only the virtual FreeAuto router is always surfaced.
	// This is a display-only policy — a committed hidden selection is
	// preserved and shown via the picker's "not in current list" affordance,
	// and the running task's model is never changed by this filter.
	const [unlockPlinyPaid] = usePlinyUnlockPaidModels()
	const [unlockPlinyFree] = usePlinyUnlockFreeModels()
	const catalogModels = state?.models ?? {}
	const catalogDefaultModelId = state?.defaultModelId ?? ""
	const { models, defaultModelId } = useMemo(
		() =>
			providerId === "pliny"
				? filterPlinyModels(catalogModels, catalogDefaultModelId, unlockPlinyPaid, unlockPlinyFree)
				: { models: catalogModels, defaultModelId: catalogDefaultModelId },
		[providerId, catalogModels, catalogDefaultModelId, unlockPlinyPaid, unlockPlinyFree],
	)

	return {
		models,
		defaultModelId,
		isLoading: state?.isLoading ?? false,
		isStale: state?.isStale ?? false,
		error: state?.error,
		refresh,
		fingerprint: state?.configFingerprint ?? "",
	}
}
