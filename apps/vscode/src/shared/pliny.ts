import type { ApiProvider } from "@shared/api"

export const PLINY_PROVIDER_ID = "pliny" as const satisfies ApiProvider

/**
 * Virtual router model. Mirrors `PLINY_FREE_AUTO_MODEL_ID` in
 * `@plinycode/llms`; the two are asserted equal by a unit test so the webview
 * and extension never drift from the SDK catalog.
 */
export const PLINY_FREE_AUTO_MODEL_ID = "pliny/auto-free"

/**
 * Virtual BalanceAuto router. Mirrors `PLINY_BALANCE_AUTO_MODEL_ID` in
 * `@plinycode/llms`. Unlike FreeAuto it may route to paid models, so it is
 * neither free nor always visible.
 */
export const PLINY_BALANCE_AUTO_MODEL_ID = "pliny/auto-paid-balanced"

const LEGACY_FREE_AUTO_MODEL_ID = "pliny/free-auto"
const LEGACY_BALANCE_AUTO_MODEL_ID = "pliny/balance-auto"

/**
 * Map a router id from before the `auto-*` rename (`pliny/free-auto[-<profile>]`,
 * `pliny/balance-auto`) onto its current id. Mirrors `canonicalPlinyModelId` in
 * `@plinycode/llms`; every other id is returned unchanged.
 */
export function canonicalPlinyModelId(modelId: string): string {
	if (modelId === LEGACY_FREE_AUTO_MODEL_ID) {
		return PLINY_FREE_AUTO_MODEL_ID
	}
	if (modelId.startsWith(`${LEGACY_FREE_AUTO_MODEL_ID}-`)) {
		return `${PLINY_FREE_AUTO_MODEL_ID}${modelId.slice(LEGACY_FREE_AUTO_MODEL_ID.length)}`
	}
	if (modelId === LEGACY_BALANCE_AUTO_MODEL_ID) {
		return PLINY_BALANCE_AUTO_MODEL_ID
	}
	return modelId
}

/** Concrete model used wherever a virtual router id cannot be routed. */
export const PLINY_FREE_AUTO_FALLBACK_MODEL_ID = "snps-provider/kimi-k2.6"

export const PLINY_DEFAULT_MODEL_ID = PLINY_FREE_AUTO_MODEL_ID

/**
 * URI the webview passes to `FileServiceClient.openFile` to open the FreeAuto
 * routing rules. The real path depends on the host data directory, which the
 * webview does not know, so the host resolves it (and creates the file if
 * needed) behind this identifier.
 */
export const PLINY_FREE_AUTO_RULES_URI = "pliny://free-auto-rules"

/** True for the virtual router id and its profile ids (`pliny/auto-free-fast`, ...). */
export function isPlinyFreeAutoModelId(modelId: string | undefined | null): boolean {
	if (typeof modelId !== "string") {
		return false
	}
	const id = canonicalPlinyModelId(modelId)
	return id === PLINY_FREE_AUTO_MODEL_ID || id.startsWith(`${PLINY_FREE_AUTO_MODEL_ID}-`)
}

/** True for the virtual BalanceAuto router id. */
export function isPlinyBalanceAutoModelId(modelId: string | undefined | null): boolean {
	return typeof modelId === "string" && canonicalPlinyModelId(modelId) === PLINY_BALANCE_AUTO_MODEL_ID
}

/** True for every virtual router id: the FreeAuto profiles and BalanceAuto. */
export function isPlinyRouterModelId(modelId: string | undefined | null): boolean {
	return isPlinyFreeAutoModelId(modelId) || isPlinyBalanceAutoModelId(modelId)
}

/** True for free self-hosted Pliny models (all `snps-provider*` pools). */
export function isPlinySelfHostedModelId(modelId: string | undefined | null): boolean {
	return typeof modelId === "string" && modelId.startsWith("snps-provider")
}

/** True for anything that costs nothing: the free models and the FreeAuto router. BalanceAuto is not free. */
export function isPlinyFreeModelId(modelId: string | undefined | null): boolean {
	return isPlinyFreeAutoModelId(modelId) || isPlinySelfHostedModelId(modelId)
}

/** Map a virtual router id onto a model the gateway can resolve. */
export function resolvePlinyConcreteModelId(
	modelId: string | undefined,
	fallbackModelId: string = PLINY_FREE_AUTO_FALLBACK_MODEL_ID,
): string {
	return modelId && isPlinyRouterModelId(modelId) ? fallbackModelId : (modelId ?? fallbackModelId)
}

export function coerceToPlinyProvider(_providerId: string | undefined | null): ApiProvider {
	return PLINY_PROVIDER_ID
}
