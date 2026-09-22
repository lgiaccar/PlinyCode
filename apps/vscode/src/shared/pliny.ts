import type { ApiProvider } from "@shared/api"

export const PLINY_PROVIDER_ID = "pliny" as const satisfies ApiProvider
export const PLINY_DEFAULT_MODEL_ID = "snps-provider/kimi-k2.6"

/** Featured Pliny models for any remaining "recommended" UI surfaces. */
export const PLINY_FEATURED_MODELS = [
	{
		id: "snps-provider/kimi-k2.6",
		name: "Kimi K2.6",
		description: "Default self-hosted MoE via Pliny",
		tags: ["DEFAULT", "SELF-HOSTED"],
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

export function isPlinyProviderId(providerId: string | undefined | null): boolean {
	return providerId === PLINY_PROVIDER_ID
}

export function coerceToPlinyProvider(_providerId: string | undefined | null): ApiProvider {
	return PLINY_PROVIDER_ID
}
