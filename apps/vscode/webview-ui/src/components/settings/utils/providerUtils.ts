import type { ApiConfiguration, ApiProvider, ModelInfo } from "@shared/api"
import { coerceToPlinyProvider } from "@shared/pliny"
import type { Mode } from "@shared/storage/types"
import * as reasoningSupport from "@shared/utils/reasoning-support"

export function supportsReasoningEffortForModelId(modelId?: string, _allowShortOpenAiIds = false): boolean {
	return reasoningSupport.supportsReasoningEffortForModel(modelId)
}

// Webview components must source provider models via
// `useProviderModels(providerId)`, which talks to the extension over
// gRPC and ultimately reads from `@plinycode/llms`. Do not add a static
// catalog here — it would silently bypass the SDK. If a new caller
// needs model lists synchronously, derive them from the catalog hook
// instead.

/**
 * Interface for normalized API configuration
 */
export interface NormalizedApiConfig {
	selectedProvider: ApiProvider
	selectedModelId: string
	selectedModelInfo: ModelInfo
}

/**
 * Gets mode-specific field values from API configuration. The provider is
 * always Pliny: a provider id stored by an older version reads as `pliny`.
 * @param apiConfiguration The API configuration object
 * @param mode The current mode ("plan" or "act")
 * @returns Object containing mode-specific field values for clean destructuring
 */
export function getModeSpecificFields(apiConfiguration: ApiConfiguration | undefined, mode: Mode) {
	if (!apiConfiguration) {
		return {
			apiProvider: undefined,
			apiModelId: undefined,
			thinkingBudgetTokens: undefined,
			reasoningEffort: undefined,
		}
	}

	return {
		apiProvider: coerceToPlinyProvider(
			mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider,
		),
		apiModelId: mode === "plan" ? apiConfiguration.planModeApiModelId : apiConfiguration.actModeApiModelId,
		thinkingBudgetTokens:
			mode === "plan" ? apiConfiguration.planModeThinkingBudgetTokens : apiConfiguration.actModeThinkingBudgetTokens,
		reasoningEffort: mode === "plan" ? apiConfiguration.planModeReasoningEffort : apiConfiguration.actModeReasoningEffort,
	}
}

/**
 * Synchronizes mode configurations by copying the source mode's settings to both modes
 * This is used when the "Use different models for Plan and Act modes" toggle is unchecked
 */
export async function syncModeConfigurations(
	apiConfiguration: ApiConfiguration | undefined,
	sourceMode: Mode,
	handleFieldsChange: (updates: Partial<ApiConfiguration>) => Promise<void>,
): Promise<void> {
	if (!apiConfiguration) {
		return
	}

	const sourceFields = getModeSpecificFields(apiConfiguration, sourceMode)
	const { apiProvider } = sourceFields

	if (!apiProvider) {
		return
	}

	await handleFieldsChange({
		planModeApiProvider: apiProvider,
		actModeApiProvider: apiProvider,
		planModeApiModelId: sourceFields.apiModelId,
		actModeApiModelId: sourceFields.apiModelId,
		planModeThinkingBudgetTokens: sourceFields.thinkingBudgetTokens,
		actModeThinkingBudgetTokens: sourceFields.thinkingBudgetTokens,
		planModeReasoningEffort: sourceFields.reasoningEffort,
		actModeReasoningEffort: sourceFields.reasoningEffort,
	})
}
