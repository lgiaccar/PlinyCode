import type {
	GatewayModelOperationCapability,
	GatewayModelToolCapability,
	GatewayProviderMetadata,
	GatewayProviderSettings,
	ProviderCapability,
	ProviderConfigField,
} from "@plinycode/shared";
import type {
	ModelInfo,
	ProviderClient,
	ProviderProtocol,
} from "../catalog/types";

export type ProviderFamily =
	| "cline"
	| "openai"
	| "openai-compatible"
	| "anthropic"
	| "google"
	| "vertex"
	| "bedrock"
	| "mistral"
	| "claude-code"
	| "openai-codex"
	| "opencode"
	| "dify"
	| "ollama"
	| "sap-ai-core";

export type ProviderApiLine = "china" | "international";

export interface BuiltinSpec {
	id: string;
	name: string;
	description: string;
	family: ProviderFamily;
	protocol?: ProviderProtocol;
	client?: ProviderClient;
	modelToolCapabilities?: readonly GatewayModelToolCapability[];
	modelOperationCapabilities?: readonly GatewayModelOperationCapability[];
	capabilities?: ProviderCapability[];
	popular?: number;
	modelsProviderId?: string;
	defaultModelId?: string;
	modelsFactory?: () => Record<string, ModelInfo>;
	env?: readonly ("browser" | "node")[];
	apiKeyEnv?: readonly string[];
	modelsSourceUrl?: string;
	docsUrl?: string;
	defaults?: GatewayProviderSettings;
	/**
	 * Regional endpoint routing facts: base URL per API line. Used when the
	 * caller selects an `apiLine` without an explicit base URL. The line that
	 * matches `defaults.baseUrl` is included so the mapping is exhaustive and
	 * self-documenting.
	 */
	apiLineBaseUrls?: Readonly<Partial<Record<ProviderApiLine, string>>>;
	configFields?: readonly ProviderConfigField[];
	metadata?: GatewayProviderMetadata;
}

/**
 * PlinyCode ships only the OpenAI-compatible and Anthropic AI SDK adapters, so
 * a provider that needs any other adapter (OpenAI Responses, Google,
 * Bedrock, ...) can't run. Shared by the runtime registry (`builtins.ts`,
 * filtering `GENERATED_PROVIDER_SPECS`) and the standalone catalog generator
 * (`catalog-live.ts`, filtering models.dev providers before they are written
 * to the generated files) so both agree on what PlinyCode can reach.
 */
export function usesShippedAdapter(
	spec: Pick<BuiltinSpec, "family" | "protocol" | "client">,
): boolean {
	return (
		(spec.family === "openai-compatible" || spec.family === "anthropic") &&
		spec.protocol !== "openai-responses" &&
		spec.client !== "openai"
	);
}
