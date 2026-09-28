import type { ModelModalities, ModelOperation, ModelOperationMode } from "@plinycode/shared"
import { ApiFormat } from "./proto/cline/models"
import type { ApiHandlerSettings } from "./storage/state-keys"

/**
 * PlinyCode only talks to the Pliny gateway. The other ids remain until the
 * Cline account and OCA plumbing that still names them is gone; stored
 * configurations with any other provider id are read as `pliny` (see
 * `coerceToPlinyProvider` in `@shared/pliny`).
 */
export type ApiProvider = "pliny" | "cline" | "cline-pass" | "oca"

export const DEFAULT_API_PROVIDER = "pliny" as ApiProvider

export interface ApiHandlerOptions extends Partial<ApiHandlerSettings> {
	ulid?: string // Used to identify the task in API requests
}

export type ApiConfiguration = ApiHandlerOptions

// Models

interface PriceTier {
	tokenLimit: number // Upper limit (inclusive) of *input* tokens for this price. Use Infinity for the highest tier.
	price: number // Price per million tokens for this tier.
}

export interface ModelInfo {
	name?: string
	maxTokens?: number
	contextWindow?: number
	/** Prompt/input token budget reported by the provider. Kept separate from the total context window. */
	maxInputTokens?: number
	supportsImages?: boolean
	supportsPromptCache: boolean // this value is hardcoded for now
	supportsReasoning?: boolean // Whether the model supports reasoning/thinking mode
	inputPrice?: number // Keep for non-tiered input models
	outputPrice?: number // Keep for non-tiered output models
	thinkingConfig?: {
		maxBudget?: number // Max allowed thinking budget tokens
		outputPrice?: number // Output price per million tokens when budget > 0
		outputPriceTiers?: PriceTier[] // Optional: Tiered output price when budget > 0
		geminiThinkingLevel?: "low" | "high" // Optional: preset thinking level
		supportsThinkingLevel?: boolean // Whether the model supports thinking level (low/high)
	}
	supportsGlobalEndpoint?: boolean // Whether the model supports a global endpoint with Vertex AI
	cacheWritesPrice?: number
	cacheReadsPrice?: number
	description?: string
	tiers?: {
		contextWindow: number
		inputPrice?: number
		outputPrice?: number
		cacheWritesPrice?: number
		cacheReadsPrice?: number
	}[]
	temperature?: number
	apiFormat?: ApiFormat // The API format used by this model
	/**
	 * SDK capability list preserved verbatim at the catalog boundary
	 * (`adaptSdkModelInfo`). Never reconstruct this from the boolean flags
	 * above — those cover only a subset of capabilities (e.g. `tools` has no
	 * boolean), and the SDK treats a populated list as authoritative. Absent
	 * means "capabilities unknown", which SDK checks fail open on.
	 */
	capabilities?: readonly string[]
	/** SDK input/output modalities preserved for runtime model routing. */
	modalities?: ModelModalities
	/** SDK provider operation preserved for endpoint routing. */
	operation?: ModelOperation
	/** SDK execution modes preserved for operation-specific clients. */
	operationModes?: readonly ModelOperationMode[]
	/** Parameter counts in billions. `activeB` below `totalB` marks a mixture-of-experts model. */
	parameters?: { totalB?: number; activeB?: number }
	/**
	 * No price is known. `inputPrice` / `outputPrice` still default to 0 for cost
	 * accounting, so display code must check this before rendering them as free.
	 */
	pricingUnavailable?: boolean
	/** Where the price comes from, or how a router model is billed. */
	pricingNote?: string
}

export interface OpenAiCompatibleModelInfo extends ModelInfo {
	temperature?: number
	systemRole?: "developer" | "system"
	supportsReasoningEffort?: boolean
	supportsTools?: boolean
	supportsStreaming?: boolean
}

export interface OcaModelInfo extends OpenAiCompatibleModelInfo {
	modelName: string
	surveyId?: string
	banner?: string
	surveyContent?: string
	supportsReasoning?: boolean
	reasoningEffortOptions: string[]
}

export const openAiModelInfoSafeDefaults: OpenAiCompatibleModelInfo = {
	maxTokens: -1,
	contextWindow: 128_000,
	supportsImages: true,
	supportsPromptCache: false,
	inputPrice: 0,
	outputPrice: 0,
	temperature: 0,
}
