import type { ApiProvider } from "@shared/api"

export const PLINY_PROVIDER_ID = "pliny" as const satisfies ApiProvider

/**
 * Virtual router model. Mirrors `PLINY_FREE_AUTO_MODEL_ID` in
 * `@plinycode/llms`; the two are asserted equal by a unit test so the webview
 * and extension never drift from the SDK catalog.
 */
export const PLINY_FREE_AUTO_MODEL_ID = "pliny/free-auto"

/** Concrete model used wherever the virtual id cannot be routed. */
export const PLINY_FREE_AUTO_FALLBACK_MODEL_ID = "snps-provider/kimi-k2.6"

export const PLINY_DEFAULT_MODEL_ID = PLINY_FREE_AUTO_MODEL_ID

/** Featured Pliny models for any remaining "recommended" UI surfaces. */
export const PLINY_FEATURED_MODELS = [
	{
		id: PLINY_FREE_AUTO_MODEL_ID,
		name: "FreeAuto (router)",
		description: "Picks the best free model per task and fails over automatically",
		tags: ["DEFAULT", "FREE"],
	},
	{
		id: "snps-provider/kimi-k2.6",
		name: "Kimi K2.6",
		description: "Self-hosted MoE via Pliny",
		tags: ["SELF-HOSTED"],
	},
	{
		id: "snps-aws-bedrock/aws-claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		description: "Hosted coder via Pliny (Bedrock)",
		tags: ["HOSTED"],
	},
	{
		id: "snps-aws-bedrock/global.anthropic.claude-sonnet-5",
		name: "Claude Sonnet 5",
		description: "Strongest hosted coder on Pliny; supports prompt caching",
		tags: ["HOSTED"],
	},
	{
		id: "snps-provider/GLM-5.2",
		name: "GLM-5.2",
		description: "Largest self-hosted context (512k) via Pliny",
		tags: ["SELF-HOSTED"],
	},
	{
		id: "snps-provider/qwen3-coder-480b-a35b-inst-fp8",
		name: "Qwen3 Coder 480B",
		description: "Coding-specialised self-hosted model",
		tags: ["SELF-HOSTED"],
	},
	{
		id: "azure-openai/gpt-5.2",
		name: "GPT-5.2",
		description: "Hosted via Pliny Azure OpenAI (auto-caches)",
		tags: ["HOSTED"],
	},
] as const

/**
 * URI the webview passes to `FileServiceClient.openFile` to open the FreeAuto
 * routing rules. The real path depends on the host data directory, which the
 * webview does not know, so the host resolves it (and creates the file if
 * needed) behind this identifier.
 */
export const PLINY_FREE_AUTO_RULES_URI = "pliny://free-auto-rules"

/** True for the virtual router id and its profile ids (`pliny/free-auto-fast`, ...). */
export function isPlinyFreeAutoModelId(modelId: string | undefined | null): boolean {
	return (
		typeof modelId === "string" &&
		(modelId === PLINY_FREE_AUTO_MODEL_ID || modelId.startsWith(`${PLINY_FREE_AUTO_MODEL_ID}-`))
	)
}

/** True for free self-hosted Pliny models (all `snps-provider*` pools). */
export function isPlinySelfHostedModelId(modelId: string | undefined | null): boolean {
	return typeof modelId === "string" && modelId.startsWith("snps-provider")
}

/** True for anything that costs nothing: the free models and the router. */
export function isPlinyFreeModelId(modelId: string | undefined | null): boolean {
	return isPlinyFreeAutoModelId(modelId) || isPlinySelfHostedModelId(modelId)
}

/** Map the virtual router id onto a model the gateway can resolve. */
export function resolvePlinyConcreteModelId(
	modelId: string | undefined,
	fallbackModelId: string = PLINY_FREE_AUTO_FALLBACK_MODEL_ID,
): string {
	return modelId && isPlinyFreeAutoModelId(modelId) ? fallbackModelId : (modelId ?? fallbackModelId)
}

export function isPlinyProviderId(providerId: string | undefined | null): boolean {
	return providerId === PLINY_PROVIDER_ID
}

export function coerceToPlinyProvider(_providerId: string | undefined | null): ApiProvider {
	return PLINY_PROVIDER_ID
}
