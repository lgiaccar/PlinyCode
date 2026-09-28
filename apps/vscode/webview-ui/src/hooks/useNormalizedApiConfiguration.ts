import type { ModelInfo } from "@shared/api"
import { PLINY_PROVIDER_ID } from "@shared/pliny"
import { ResolveModelInfoRequest } from "@shared/proto/cline/models"
import { fromProtobufModelInfo } from "@shared/proto-conversions/models/typeConversion"
import type { Mode } from "@shared/storage/types"
import { useEffect, useMemo, useState } from "react"
import { getModeSpecificFields, type NormalizedApiConfig } from "@/components/settings/utils/providerUtils"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"

/**
 * Neutral placeholder returned while the catalog has not yet produced a
 * concrete `ModelInfo`. Callers that gate behavior on capabilities
 * (TaskHeader cost display, context-window meter, prompt-cache reasoning
 * surfaces) read these defaults as "we don't know yet" — see the field
 * comments at consumers.
 */
const unknownModelInfo: ModelInfo = {
	supportsPromptCache: false,
}

/**
 * The provider and model the mode runs on. The provider is always Pliny (a
 * provider id stored by an older version reads as `pliny`), and Pliny keeps
 * its model id in the generic `{plan,act}ModeApiModelId` field.
 */
function getActiveProviderAndModelId(apiConfiguration: ReturnType<typeof useExtensionState>["apiConfiguration"], mode: Mode) {
	const modeFields = getModeSpecificFields(apiConfiguration, mode)
	return {
		provider: modeFields.apiProvider ?? PLINY_PROVIDER_ID,
		modelId: modeFields.apiModelId,
	}
}

/**
 * Webview's universal handle on "what model is currently selected, with
 * what capabilities". Sources its answer from the extension over gRPC
 * (`ResolveModelInfo`), which combines the SDK catalog with the user's
 * committed selection.
 *
 * The returned `selectedModelInfo` may be `unknownModelInfo` for a few
 * render frames while the gRPC call is in flight, especially the first
 * time a provider is selected after a config change. UI callers must
 * treat `unknownModelInfo` as "no data yet" — render placeholders, do
 * not assume features are unsupported.
 */
export function useNormalizedApiConfiguration(mode: Mode): NormalizedApiConfig {
	const { apiConfiguration } = useExtensionState()
	const { provider, modelId } = getActiveProviderAndModelId(apiConfiguration, mode)
	const [resolvedInfo, setResolvedInfo] = useState<
		Awaited<ReturnType<typeof ModelsServiceClient.resolveModelInfo>> | undefined
	>(undefined)

	useEffect(() => {
		setResolvedInfo(undefined)
		let cancelled = false
		// The host-side handler awaits the catalog on a cache miss, so a
		// single round-trip yields authoritative data. We do not retry
		// or warm; if the response is `unknown`, the catalog truly has no
		// data and the UI renders a placeholder.
		void ModelsServiceClient.resolveModelInfo(
			ResolveModelInfoRequest.create({ providerId: provider, modelId: modelId || undefined }),
		)
			.then((response) => {
				if (!cancelled) {
					setResolvedInfo(response)
				}
			})
			.catch(() => {
				// The handler does not throw in production paths; a host-side
				// error here is logged at the gRPC layer. Leave resolvedInfo
				// undefined so the hook returns the neutral loading state.
			})
		return () => {
			cancelled = true
		}
	}, [provider, modelId])

	return useMemo(() => {
		if (!resolvedInfo || resolvedInfo.source === "unknown" || !resolvedInfo.modelInfo) {
			return {
				selectedProvider: provider,
				selectedModelId: resolvedInfo?.modelId || modelId || "",
				selectedModelInfo: unknownModelInfo,
			}
		}
		return {
			selectedProvider: provider,
			selectedModelId: resolvedInfo.modelId,
			selectedModelInfo: fromProtobufModelInfo(resolvedInfo.modelInfo),
		}
	}, [provider, modelId, resolvedInfo])
}
