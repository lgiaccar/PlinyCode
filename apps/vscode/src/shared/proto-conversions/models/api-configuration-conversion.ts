import {
	OpenRouterModelInfo,
	ModelsApiConfiguration as ProtoApiConfiguration,
	OcaModelInfo as ProtoOcaModelInfo,
	ThinkingConfig,
} from "@shared/proto/cline/models"
import { ApiConfiguration, ApiProvider, ModelInfo, OcaModelInfo } from "../../api"
import { coerceToPlinyProvider } from "../../pliny"
import { OpenaiReasoningEffort } from "../../storage/types"

// Convert application ThinkingConfig to proto ThinkingConfig
function convertThinkingConfigToProto(config: ModelInfo["thinkingConfig"]): ThinkingConfig | undefined {
	if (!config) {
		return undefined
	}

	return {
		maxBudget: config.maxBudget,
		outputPrice: config.outputPrice,
		outputPriceTiers: config.outputPriceTiers || [], // Provide empty array if undefined
	}
}

// Convert proto ThinkingConfig to application ThinkingConfig
function convertProtoToThinkingConfig(config: ThinkingConfig | undefined): ModelInfo["thinkingConfig"] | undefined {
	if (!config) {
		return undefined
	}

	return {
		maxBudget: config.maxBudget,
		outputPrice: config.outputPrice,
		outputPriceTiers: config.outputPriceTiers.length > 0 ? config.outputPriceTiers : undefined,
	}
}

// Convert application ModelInfo to proto OpenRouterModelInfo
function convertModelInfoToProtoOpenRouter(info: ModelInfo | undefined): OpenRouterModelInfo | undefined {
	if (!info) {
		return undefined
	}

	return {
		maxTokens: info.maxTokens,
		contextWindow: info.contextWindow,
		supportsImages: info.supportsImages,
		supportsPromptCache: info.supportsPromptCache ?? false,
		inputPrice: info.inputPrice,
		outputPrice: info.outputPrice,
		cacheWritesPrice: info.cacheWritesPrice,
		cacheReadsPrice: info.cacheReadsPrice,
		description: info.description,
		thinkingConfig: convertThinkingConfigToProto(info.thinkingConfig),
		supportsGlobalEndpoint: info.supportsGlobalEndpoint,
		tiers: info.tiers || [],
	}
}

// Convert proto OpenRouterModelInfo to application ModelInfo
function convertProtoToModelInfo(info: OpenRouterModelInfo | undefined): ModelInfo | undefined {
	if (!info) {
		return undefined
	}

	return {
		maxTokens: info.maxTokens,
		contextWindow: info.contextWindow,
		supportsImages: info.supportsImages,
		supportsPromptCache: info.supportsPromptCache,
		inputPrice: info.inputPrice,
		outputPrice: info.outputPrice,
		cacheWritesPrice: info.cacheWritesPrice,
		cacheReadsPrice: info.cacheReadsPrice,
		description: info.description,
		thinkingConfig: convertProtoToThinkingConfig(info.thinkingConfig),
		supportsGlobalEndpoint: info.supportsGlobalEndpoint,
		tiers: info.tiers.length > 0 ? info.tiers : undefined,
	}
}

// Convert application ModelInfo to proto OcaModelInfo
function convertOcaModelInfoToProtoOcaModelInfo(info: OcaModelInfo | undefined): ProtoOcaModelInfo | undefined {
	if (!info) {
		return undefined
	}

	return {
		maxTokens: info.maxTokens,
		contextWindow: info.contextWindow,
		supportsImages: info.supportsImages,
		supportsPromptCache: info.supportsPromptCache ?? false,
		inputPrice: info.inputPrice,
		outputPrice: info.outputPrice,
		cacheWritesPrice: info.cacheWritesPrice,
		cacheReadsPrice: info.cacheReadsPrice,
		description: info.description,
		thinkingConfig: convertThinkingConfigToProto(info.thinkingConfig),
		surveyContent: info.surveyContent,
		surveyId: info.surveyId,
		banner: info.banner,
		modelName: info.modelName,
		apiFormat: info.apiFormat,
		supportsReasoning: info.supportsReasoning,
		reasoningEffortOptions: info.reasoningEffortOptions,
	}
}

// Convert proto OcaModelInfo to application OcaModelInfo
function convertProtoOcaModelInfoToOcaModelInfo(info: ProtoOcaModelInfo | undefined): OcaModelInfo | undefined {
	if (!info) {
		return undefined
	}

	return {
		maxTokens: info.maxTokens,
		contextWindow: info.contextWindow,
		supportsImages: info.supportsImages,
		supportsPromptCache: info.supportsPromptCache,
		inputPrice: info.inputPrice,
		outputPrice: info.outputPrice,
		cacheWritesPrice: info.cacheWritesPrice,
		cacheReadsPrice: info.cacheReadsPrice,
		description: info.description,
		surveyContent: info.surveyContent,
		surveyId: info.surveyId,
		banner: info.banner,
		modelName: info.modelName,
		apiFormat: info.apiFormat,
		supportsReasoning: info.supportsReasoning,
		reasoningEffortOptions: info.reasoningEffortOptions,
	}
}

// Provider ids travel over the wire as plain strings. PlinyCode only runs on
// Pliny, so whatever id a proto message carries is read as `pliny`; this is the
// single place that maps a wire value onto `ApiProvider`.
export function convertProtoToApiProvider(provider: string | undefined): ApiProvider {
	return coerceToPlinyProvider(provider)
}

// Converts application ApiConfiguration to proto ApiConfiguration
export function convertApiConfigurationToProto(config: ApiConfiguration): ProtoApiConfiguration {
	return {
		// Global configuration fields
		clineAccountId: config.clineAccountId,
		ulid: config.ulid,
		ocaBaseUrl: config.ocaBaseUrl,
		clineApiKey: config.clineApiKey,
		ocaMode: config.ocaMode,

		// Plan mode configurations
		planModeApiProvider: config.planModeApiProvider,
		planModeApiModelId: config.planModeApiModelId,
		planModeThinkingBudgetTokens: config.planModeThinkingBudgetTokens,
		planModeReasoningEffort: config.planModeReasoningEffort,
		planModeClineModelId: config.planModeClineModelId,
		planModeClineModelInfo: convertModelInfoToProtoOpenRouter(config.planModeClineModelInfo),
		planModeClinePassModelId: config.planModeClinePassModelId,
		planModeClinePassModelInfo: convertModelInfoToProtoOpenRouter(config.planModeClinePassModelInfo),
		planModeOcaModelId: config.planModeOcaModelId,
		planModeOcaModelInfo: convertOcaModelInfoToProtoOcaModelInfo(config.planModeOcaModelInfo),
		planModeOcaReasoningEffort: config.planModeOcaReasoningEffort,

		// Act mode configurations
		actModeApiProvider: config.actModeApiProvider,
		actModeApiModelId: config.actModeApiModelId,
		actModeThinkingBudgetTokens: config.actModeThinkingBudgetTokens,
		actModeReasoningEffort: config.actModeReasoningEffort,
		actModeClineModelId: config.actModeClineModelId,
		actModeClineModelInfo: convertModelInfoToProtoOpenRouter(config.actModeClineModelInfo),
		actModeClinePassModelId: config.actModeClinePassModelId,
		actModeClinePassModelInfo: convertModelInfoToProtoOpenRouter(config.actModeClinePassModelInfo),
		actModeOcaModelId: config.actModeOcaModelId,
		actModeOcaModelInfo: convertOcaModelInfoToProtoOcaModelInfo(config.actModeOcaModelInfo),
		actModeOcaReasoningEffort: config.actModeOcaReasoningEffort,
	}
}

// Converts proto ApiConfiguration to application ApiConfiguration
export function convertProtoToApiConfiguration(protoConfig: ProtoApiConfiguration): ApiConfiguration {
	return {
		// Global configuration fields
		clineAccountId: protoConfig.clineAccountId,
		ulid: protoConfig.ulid,
		ocaBaseUrl: protoConfig.ocaBaseUrl,
		ocaMode: protoConfig.ocaMode,
		clineApiKey: protoConfig.clineApiKey,

		// Plan mode configurations
		planModeApiProvider:
			protoConfig.planModeApiProvider !== undefined
				? convertProtoToApiProvider(protoConfig.planModeApiProvider)
				: undefined,
		planModeApiModelId: protoConfig.planModeApiModelId,
		planModeThinkingBudgetTokens: protoConfig.planModeThinkingBudgetTokens,
		planModeReasoningEffort: protoConfig.planModeReasoningEffort as OpenaiReasoningEffort | undefined,
		planModeClineModelId: protoConfig.planModeClineModelId,
		planModeClineModelInfo: convertProtoToModelInfo(protoConfig.planModeClineModelInfo),
		planModeClinePassModelId: protoConfig.planModeClinePassModelId,
		planModeClinePassModelInfo: convertProtoToModelInfo(protoConfig.planModeClinePassModelInfo),
		planModeOcaModelId: protoConfig.planModeOcaModelId,
		planModeOcaModelInfo: convertProtoOcaModelInfoToOcaModelInfo(protoConfig.planModeOcaModelInfo),
		planModeOcaReasoningEffort: protoConfig.planModeOcaReasoningEffort,

		// Act mode configurations
		actModeApiProvider:
			protoConfig.actModeApiProvider !== undefined ? convertProtoToApiProvider(protoConfig.actModeApiProvider) : undefined,
		actModeApiModelId: protoConfig.actModeApiModelId,
		actModeThinkingBudgetTokens: protoConfig.actModeThinkingBudgetTokens,
		actModeReasoningEffort: protoConfig.actModeReasoningEffort as OpenaiReasoningEffort | undefined,
		actModeClineModelId: protoConfig.actModeClineModelId,
		actModeClineModelInfo: convertProtoToModelInfo(protoConfig.actModeClineModelInfo),
		actModeClinePassModelId: protoConfig.actModeClinePassModelId,
		actModeClinePassModelInfo: convertProtoToModelInfo(protoConfig.actModeClinePassModelInfo),
		actModeOcaModelId: protoConfig.actModeOcaModelId,
		actModeOcaModelInfo: convertProtoOcaModelInfoToOcaModelInfo(protoConfig.actModeOcaModelInfo),
		actModeOcaReasoningEffort: protoConfig.actModeOcaReasoningEffort,
	}
}
