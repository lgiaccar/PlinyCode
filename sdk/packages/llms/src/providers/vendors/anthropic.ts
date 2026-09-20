import { createAnthropic } from "@ai-sdk/anthropic";
import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { resolveApiKey } from "../http";
import type { ProviderFactoryResult } from "./types";

export async function createAnthropicProviderModule(
	config: GatewayResolvedProviderConfig,
	context: GatewayProviderContext,
): Promise<ProviderFactoryResult> {
	const apiKey = await resolveApiKey(config);
	const provider = createAnthropic({
		apiKey,
		baseURL: config.baseUrl,
		headers: config.headers,
		fetch: config.fetch,
		name: context.provider.id,
	});
	return {
		buildModelTools: (tools) => {
			const result: ReturnType<
				NonNullable<ProviderFactoryResult["buildModelTools"]>
			> = {};
			for (const tool of tools) {
				if (tool.name === "web_search") {
					result.web_search = {
						tool: provider.tools.webSearch_20250305({
							maxUses: tool.maxUses,
							allowedDomains: tool.allowedDomains,
							blockedDomains: tool.blockedDomains,
							userLocation: tool.userLocation
								? { type: "approximate", ...tool.userLocation }
								: undefined,
						}),
					};
				}
			}
			return result;
		},
		operations: {
			language: (modelId) => provider(modelId),
		},
	};
}
