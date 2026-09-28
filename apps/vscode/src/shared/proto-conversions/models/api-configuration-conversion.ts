import { ModelsApiConfiguration as ProtoApiConfiguration } from "@shared/proto/cline/models"
import { ApiConfiguration, ApiProvider } from "../../api"
import { coerceToPlinyProvider } from "../../pliny"
import { OpenaiReasoningEffort } from "../../storage/types"

// Provider ids travel over the wire as plain strings. PlinyCode only runs on
// Pliny, so whatever id a proto message carries is read as `pliny`; this is the
// single place that maps a wire value onto `ApiProvider`.
export function convertProtoToApiProvider(provider: string | undefined): ApiProvider {
	return coerceToPlinyProvider(provider)
}

// Converts application ApiConfiguration to proto ApiConfiguration
export function convertApiConfigurationToProto(config: ApiConfiguration): ProtoApiConfiguration {
	return {
		ulid: config.ulid,

		// Plan mode configurations
		planModeApiProvider: config.planModeApiProvider,
		planModeApiModelId: config.planModeApiModelId,
		planModeThinkingBudgetTokens: config.planModeThinkingBudgetTokens,
		planModeReasoningEffort: config.planModeReasoningEffort,

		// Act mode configurations
		actModeApiProvider: config.actModeApiProvider,
		actModeApiModelId: config.actModeApiModelId,
		actModeThinkingBudgetTokens: config.actModeThinkingBudgetTokens,
		actModeReasoningEffort: config.actModeReasoningEffort,
	}
}

// Converts proto ApiConfiguration to application ApiConfiguration
export function convertProtoToApiConfiguration(protoConfig: ProtoApiConfiguration): ApiConfiguration {
	return {
		ulid: protoConfig.ulid,

		// Plan mode configurations
		planModeApiProvider:
			protoConfig.planModeApiProvider !== undefined
				? convertProtoToApiProvider(protoConfig.planModeApiProvider)
				: undefined,
		planModeApiModelId: protoConfig.planModeApiModelId,
		planModeThinkingBudgetTokens: protoConfig.planModeThinkingBudgetTokens,
		planModeReasoningEffort: protoConfig.planModeReasoningEffort as OpenaiReasoningEffort | undefined,

		// Act mode configurations
		actModeApiProvider:
			protoConfig.actModeApiProvider !== undefined ? convertProtoToApiProvider(protoConfig.actModeApiProvider) : undefined,
		actModeApiModelId: protoConfig.actModeApiModelId,
		actModeThinkingBudgetTokens: protoConfig.actModeThinkingBudgetTokens,
		actModeReasoningEffort: protoConfig.actModeReasoningEffort as OpenaiReasoningEffort | undefined,
	}
}
