import type {
	GatewayProviderFactory,
	GatewayProviderRegistration,
} from "@plinycode/shared";
import {
	BUILTIN_PROVIDER_MANIFESTS_BY_ID,
	BUILTIN_SPECS,
	type ProviderFamily,
} from "./builtins";

/**
 * PlinyCode ships only the Anthropic and OpenAI-compatible adapters; builtins.ts
 * leaves out every provider that needs another one.
 */
async function loadFamilyFactory(
	family: ProviderFamily,
): Promise<GatewayProviderFactory> {
	const module = await import("./ai-sdk");
	return family === "anthropic"
		? module.createAnthropicProvider
		: module.createOpenAICompatibleProvider;
}

export const BUILTIN_PROVIDER_REGISTRATIONS: GatewayProviderRegistration[] =
	BUILTIN_SPECS.map((spec) => ({
		manifest: BUILTIN_PROVIDER_MANIFESTS_BY_ID[spec.id],
		defaults: {
			...spec.defaults,
			apiKeyEnv: spec.apiKeyEnv,
			baseUrl: spec.defaults?.baseUrl,
			// Surface the regional endpoint facts as a default option so the
			// registry can resolve a base URL from a caller-selected
			// `options.apiLine` (see GatewayRegistry.createProvider).
			...(spec.apiLineBaseUrls
				? {
						options: {
							...(spec.defaults?.options ?? {}),
							apiLineBaseUrls: spec.apiLineBaseUrls,
						},
					}
				: {}),
		},
		loadProvider: async () => ({
			createProvider: await loadFamilyFactory(spec.family),
		}),
	}));
