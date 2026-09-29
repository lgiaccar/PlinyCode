// Replaces classic src/core/api buildApiHandler (see origin/main).
//
// Builds an SDK ApiHandler (from `@plinycode/llms`) directly from the extension's
// legacy ApiConfiguration. This is the single inference path: the main task
// loop runs through ClineCore (see cline-session-factory.ts), and standalone
// utility callers (commit message generation) use the handler
// returned here. Both share the same provider/model/key/baseUrl resolution so
// there is no second source of truth.

import { type ApiHandler, createHandler, type ProviderConfig, resolvePlinyConcreteModelId } from "@plinycode/llms"
import type { ApiConfiguration } from "@shared/api"
import type { Mode } from "@shared/storage/types"
import { reasoningEffortFromThinkingBudget } from "@shared/utils/reasoning-support"
import { resolveApiKey, resolveBaseUrl, resolveModelId, resolveProviderId } from "./cline-session-factory"
import { toSdkProviderId } from "./model-catalog/sdk-provider-id"
import { createPlinyFetch, PLINY_REQUEST_TIMEOUT_MS } from "./pliny-fetch"

interface BuildApiHandlerOptions {
	/**
	 * Disable extended thinking/reasoning for this handler. Standalone utility
	 * calls (commit message generation) want fast, cheap,
	 * deterministic completions and don't benefit from reasoning. When true we
	 * send `thinking: false` and omit both effort and budget so the gateway
	 * doesn't receive a reasoning config at all.
	 */
	disableReasoning?: boolean
}

/**
 * Build an SDK `ProviderConfig` from the extension's `ApiConfiguration` for the
 * given mode (plan/act).
 *
 * Reuses the same resolvers the session factory uses to map the config onto
 * provider id, model id, API key, and base URL. The provider is always Pliny:
 * a stored id from an older version reads as `pliny`.
 *
 * Reasoning handling: the SDK gateway forwards `reasoningEffort` as
 * `reasoning.effort`. Effort is the only reasoning control the extension UI
 * exposes (matching the CLI); the SDK translates it into each provider's wire
 * format, including budget-token mapping where the provider requires one.
 * Legacy thinking budgets persisted by older versions are honored by mapping
 * them onto the effort scale when no explicit effort is stored.
 */
export function buildSdkProviderConfig(
	configuration: ApiConfiguration,
	mode: Mode,
	options?: BuildApiHandlerOptions,
): ProviderConfig {
	const providerId = resolveProviderId(mode, configuration)

	const apiKey = resolveApiKey(providerId)
	// Standalone callers (commit message generation) talk to the gateway
	// directly, so the virtual FreeAuto id — which only the agent loop knows how
	// to route — must be mapped to a concrete model here.
	const modelId = resolvePlinyConcreteModelId(resolveModelId(mode, configuration))
	const baseUrl = resolveBaseUrl(providerId)

	const reasoningEffort = mode === "plan" ? configuration.planModeReasoningEffort : configuration.actModeReasoningEffort
	const legacyThinkingBudgetTokens =
		mode === "plan" ? configuration.planModeThinkingBudgetTokens : configuration.actModeThinkingBudgetTokens

	const base: ProviderConfig = {
		providerId: toSdkProviderId(providerId),
		modelId: modelId ?? "",
		apiKey: apiKey ?? "",
		baseUrl,
		// Proxy-aware fetch with a long timeout for slow self-hosted models
		// (see .clinerules/network.md).
		fetch: createPlinyFetch(),
		timeoutMs: PLINY_REQUEST_TIMEOUT_MS,
	}

	if (options?.disableReasoning) {
		// Explicitly turn reasoning off; do not send effort or budget.
		return { ...base, thinking: false }
	}

	if (reasoningEffort === "low" || reasoningEffort === "medium" || reasoningEffort === "high" || reasoningEffort === "xhigh") {
		return { ...base, reasoningEffort }
	}
	// An explicit "none" wins over any stored legacy budget.
	if (reasoningEffort === "none") {
		return base
	}
	const budgetEffort = reasoningEffortFromThinkingBudget(legacyThinkingBudgetTokens)
	if (budgetEffort) {
		return { ...base, reasoningEffort: budgetEffort }
	}
	return base
}

/**
 * Build an SDK-backed `ApiHandler` from the extension's `ApiConfiguration`.
 *
 * This is the SDK replacement for the legacy per-provider handler factory. The
 * returned handler implements the same `createMessage`/`getModel` surface, so
 * existing callers continue to work unchanged.
 */
export function buildApiHandler(configuration: ApiConfiguration, mode: Mode, options?: BuildApiHandlerOptions): ApiHandler {
	const providerConfig = buildSdkProviderConfig(configuration, mode, options)
	const handler = createHandler(providerConfig)
	const getModel = handler.getModel.bind(handler)

	handler.getModel = () => {
		return {
			...getModel(),
			providerId: providerConfig.providerId,
		}
	}

	return handler
}
