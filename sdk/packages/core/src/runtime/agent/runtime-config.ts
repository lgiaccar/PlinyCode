import { createGateway } from "@plinycode/llms";
import type {
	AgentModel,
	AgentRuntimeConfig as BaseAgentRuntimeConfig,
	GatewayProviderSettings,
} from "@plinycode/shared";

/**
 * Advanced form: caller supplies a pre-built `AgentModel`. Used by
 * `SessionRuntime`, which constructs models itself to share gateway wiring
 * with the rest of the session runtime.
 */
export interface AgentRuntimeConfigWithModel extends BaseAgentRuntimeConfig {
	model: AgentModel;
}

/**
 * Friendly form: caller supplies provider/model IDs and credentials, and the
 * runtime builds an `AgentModel` internally via `@plinycode/llms`. This is the
 * entry point most standalone users want.
 */
export interface AgentRuntimeConfigWithProvider
	extends Omit<BaseAgentRuntimeConfig, "model"> {
	/** Provider ID (e.g., "anthropic", "openai") */
	providerId: string;
	/** Model ID to use */
	modelId: string;
	/** API key for the provider */
	apiKey?: string;
	/** Custom base URL for the API */
	baseUrl?: string;
	/** Additional headers for API requests */
	headers?: Record<string, string>;
	/** Provider-specific gateway options */
	options?: GatewayProviderSettings["options"];
}

/**
 * Config accepted by `new AgentRuntime(...)` / `createAgentRuntime(...)` /
 * `new Agent(...)` / `createAgent(...)`. Either supply a pre-built `model`
 * (advanced) or `providerId` + `modelId` (+ credentials) and the runtime will
 * construct the model itself via `@plinycode/llms`.
 */
export type AgentRuntimeConfig =
	| AgentRuntimeConfigWithModel
	| AgentRuntimeConfigWithProvider;

function hasPrebuiltModel(
	config: AgentRuntimeConfig,
): config is AgentRuntimeConfigWithModel {
	return (config as AgentRuntimeConfigWithModel).model !== undefined;
}

export function resolveRuntimeConfig(
	config: AgentRuntimeConfig,
): BaseAgentRuntimeConfig {
	if (hasPrebuiltModel(config)) {
		return config;
	}
	const { providerId, modelId, apiKey, baseUrl, headers, options, ...rest } =
		config;
	const gateway = createGateway({
		providerConfigs: [{ providerId, apiKey, baseUrl, headers, options }],
	});
	const model = gateway.createAgentModel({ providerId, modelId });
	// The prebuilt-model path preserves a caller-provided messageModelInfo;
	// mirror that here so the provider/model constructor also tags assistant
	// messages with modelInfo. An explicit caller-provided value still wins.
	const messageModelInfo = rest.messageModelInfo ?? {
		id: modelId,
		provider: providerId,
	};
	return { ...rest, model, messageModelInfo };
}
