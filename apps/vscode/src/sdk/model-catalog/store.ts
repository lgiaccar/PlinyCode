import {
	readModelsFileSync,
	resolveModelsRegistryPath,
	type StoredModelEntry,
	syncStoredProviderRegistration,
	writeModelsFileSync,
} from "@plinycode/core"
import { getGeneratedModelsForProvider, MODEL_COLLECTIONS_BY_PROVIDER_ID } from "@plinycode/llms"
import { ModelCapabilitySchema } from "@plinycode/shared"
import { type ApiConfiguration, type ApiProvider, type ModelInfo, openAiModelInfoSafeDefaults } from "@shared/api"
import { getProviderModelIdKey } from "@shared/storage/provider-keys"
import type { SettingsKey } from "@shared/storage/state-keys"
import { modelSettingsMode } from "@shared/storage/types"
import { StateManager } from "@/core/storage/StateManager"
import { getProviderSettingsManager } from "../provider-migration"
import type {
	Disposable,
	EffectiveProviderConfig,
	Mode,
	ModelSelection,
	ModelSelectionOverrides,
	ProviderConfigChange,
	ProviderConfigChangeListener,
	ProviderConfigPatch,
	ProviderConfigStore,
	ProviderId,
	ResolvedModelSelection,
} from "./contracts"
import { buildEffectiveProviderConfig } from "./effective-config"
import { fromSdkApiFormat, nonNegativeFiniteNumber, positiveFiniteNumber, toSdkApiFormat } from "./model-values"
import { toSdkProviderId } from "./sdk-provider-id"
import { adaptSdkModelInfo } from "./shape-adapter"

type ProviderSettingsRecord = Record<string, unknown>

// In-memory selection envelope for providers that have a mode-specific model
// id key but no durable `*ModelInfo` key in the StateManager schema (for
// example DeepSeek/Gemini/generic SDK-backed providers). Keyed by
// provider+mode so that switching between providers that share the same
// `*ModeApiModelId` key does not combine one provider's model id with
// another provider's model info.
const selectionMemory = new Map<string, ResolvedModelSelection>()

function providerKey(providerId: ProviderId): string {
	return providerId.toString()
}

function providerForStorage(providerId: ProviderId): ApiProvider | undefined {
	return providerKey(providerId) as ApiProvider
}

function providerSettingsProviderId(providerId: ProviderId): string {
	return toSdkProviderId(providerId)
}

function memoryKey(providerId: ProviderId, mode: Mode): string {
	return `${providerId}:${mode}`
}

function patchValue<T>(value: T | null | undefined): T | undefined {
	return value === null ? undefined : value
}

function patchStringValue(value: string | null | undefined): string | undefined {
	const patched = patchValue(value)
	return patched === "" ? undefined : patched
}

/**
 * API keys are opaque pasted tokens. Clipboards smuggle in control and
 * invisible formatting characters (newlines, zero-width spaces, BOM,
 * direction marks) that make the provider reject the key with a 401 that is
 * indistinguishable from a genuinely wrong key — while the field's masked
 * rendering hides the corruption from the user. Strip those characters and
 * surrounding whitespace before the value reaches either backing store.
 */
function sanitizeApiKeyPatch(patch: ProviderConfigPatch): ProviderConfigPatch {
	if (!("apiKey" in patch) || typeof patch.apiKey !== "string") {
		return patch
	}
	return { ...patch, apiKey: patch.apiKey.replace(/[\p{Cc}\p{Cf}]/gu, "").trim() }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isModelInfo(value: unknown): value is ModelInfo {
	return isRecord(value) && typeof value.supportsPromptCache === "boolean"
}

function isKnownModelIdForProvider(providerId: ProviderId, modelId: string): boolean {
	const sdkProviderId = toSdkProviderId(providerId)
	return Boolean(
		getGeneratedModelsForProvider(sdkProviderId)[modelId] || MODEL_COLLECTIONS_BY_PROVIDER_ID[sdkProviderId]?.models[modelId],
	)
}

function readProviderSettingsModelId(providerId: ProviderId): string | undefined {
	const model = getProviderSettings(providerId).model
	return typeof model === "string" && model.trim().length > 0 ? model.trim() : undefined
}

function sanitizeResolvedModelInfo(modelInfo: ModelInfo): ModelInfo {
	const next = { ...modelInfo }
	if (positiveFiniteNumber(next.maxTokens) === undefined) delete next.maxTokens
	if (nonNegativeFiniteNumber(next.temperature) === undefined) delete next.temperature
	return next
}

function fallbackModelInfo(modelId: string): ModelInfo {
	return sanitizeResolvedModelInfo({ ...openAiModelInfoSafeDefaults, name: modelId })
}

function toStoredCapabilities(capabilities: readonly string[] | undefined): StoredModelEntry["capabilities"] | undefined {
	if (!capabilities) {
		return undefined
	}
	// Validate against the SDK schema rather than a hardcoded list so new
	// capabilities added to ModelCapabilitySchema are never silently stripped.
	const next = new Set<NonNullable<StoredModelEntry["capabilities"]>[number]>()
	for (const capability of capabilities) {
		const parsed = ModelCapabilitySchema.safeParse(capability)
		if (parsed.success) {
			next.add(parsed.data)
		}
	}
	return next.size > 0 ? [...next] : undefined
}

function toStoredApiFormat(apiFormat: ModelInfo["apiFormat"]): StoredModelEntry["apiFormat"] | undefined {
	return toSdkApiFormat(apiFormat)
}

function fromStoredApiFormat(apiFormat: StoredModelEntry["apiFormat"]): ModelInfo["apiFormat"] | undefined {
	return fromSdkApiFormat(apiFormat)
}

function readModelsState() {
	return readModelsFileSync(resolveModelsRegistryPath(getProviderSettingsManager()))
}

/**
 * Normalizes user-authored model metadata at the host/storage boundary.
 * Token limits must be positive, prices and temperatures non-negative, and
 * unsupported capabilities/formats are omitted. UI sentinels never cross
 * this boundary; an object with no meaningful fields becomes undefined.
 */
function normalizeModelSelectionOverrides(overrides: ModelSelectionOverrides | undefined): ModelSelectionOverrides | undefined {
	if (!overrides) {
		return undefined
	}
	const maxTokens = positiveFiniteNumber(overrides.maxTokens)
	const contextWindow = positiveFiniteNumber(overrides.contextWindow)
	const maxInputTokens = positiveFiniteNumber(overrides.maxInputTokens)
	const capabilities = toStoredCapabilities(overrides.capabilities)
	const inputPrice = nonNegativeFiniteNumber(overrides.inputPrice)
	const outputPrice = nonNegativeFiniteNumber(overrides.outputPrice)
	const cacheReadsPrice = nonNegativeFiniteNumber(overrides.cacheReadsPrice)
	const cacheWritesPrice = nonNegativeFiniteNumber(overrides.cacheWritesPrice)
	const temperature = nonNegativeFiniteNumber(overrides.temperature)
	const apiFormat = toStoredApiFormat(overrides.apiFormat) !== undefined ? overrides.apiFormat : undefined
	const next: ModelSelectionOverrides = {
		...(overrides.name !== undefined ? { name: overrides.name } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
		...(capabilities !== undefined ? { capabilities } : {}),
		...(overrides.supportsVision !== undefined ? { supportsVision: overrides.supportsVision } : {}),
		...(overrides.supportsAttachments !== undefined ? { supportsAttachments: overrides.supportsAttachments } : {}),
		...(overrides.supportsReasoning !== undefined ? { supportsReasoning: overrides.supportsReasoning } : {}),
		...(inputPrice !== undefined ? { inputPrice } : {}),
		...(outputPrice !== undefined ? { outputPrice } : {}),
		...(cacheReadsPrice !== undefined ? { cacheReadsPrice } : {}),
		...(cacheWritesPrice !== undefined ? { cacheWritesPrice } : {}),
		...(temperature !== undefined ? { temperature } : {}),
		...(apiFormat !== undefined ? { apiFormat } : {}),
	}
	return Object.keys(next).length > 0 ? next : undefined
}

function toStoredModelEntry(overrides: ModelSelectionOverrides): StoredModelEntry {
	const capabilities = toStoredCapabilities(overrides.capabilities)
	const apiFormat = toStoredApiFormat(overrides.apiFormat)
	return {
		...(overrides.name !== undefined ? { name: overrides.name } : {}),
		...(overrides.maxTokens !== undefined ? { maxTokens: overrides.maxTokens } : {}),
		...(overrides.contextWindow !== undefined ? { contextWindow: overrides.contextWindow } : {}),
		...(overrides.maxInputTokens !== undefined ? { maxInputTokens: overrides.maxInputTokens } : {}),
		...(capabilities !== undefined ? { capabilities } : {}),
		...(overrides.supportsVision !== undefined ? { supportsVision: overrides.supportsVision } : {}),
		...(overrides.supportsAttachments !== undefined ? { supportsAttachments: overrides.supportsAttachments } : {}),
		...(overrides.supportsReasoning !== undefined ? { supportsReasoning: overrides.supportsReasoning } : {}),
		...(overrides.inputPrice !== undefined ? { inputPrice: overrides.inputPrice } : {}),
		...(overrides.outputPrice !== undefined ? { outputPrice: overrides.outputPrice } : {}),
		...(overrides.cacheReadsPrice !== undefined ? { cacheReadsPrice: overrides.cacheReadsPrice } : {}),
		...(overrides.cacheWritesPrice !== undefined ? { cacheWritesPrice: overrides.cacheWritesPrice } : {}),
		...(overrides.temperature !== undefined ? { temperature: overrides.temperature } : {}),
		...(apiFormat !== undefined ? { apiFormat } : {}),
	}
}

function toSelectionOverrides(entry: StoredModelEntry | undefined): ModelSelectionOverrides | undefined {
	if (!entry) {
		return undefined
	}
	const apiFormat = fromStoredApiFormat(entry.apiFormat)
	return normalizeModelSelectionOverrides({
		...(entry.name !== undefined ? { name: entry.name } : {}),
		...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
		...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
		...(entry.maxInputTokens !== undefined ? { maxInputTokens: entry.maxInputTokens } : {}),
		...(entry.capabilities !== undefined ? { capabilities: [...entry.capabilities] } : {}),
		...(entry.supportsVision !== undefined ? { supportsVision: entry.supportsVision } : {}),
		...(entry.supportsAttachments !== undefined ? { supportsAttachments: entry.supportsAttachments } : {}),
		...(entry.supportsReasoning !== undefined ? { supportsReasoning: entry.supportsReasoning } : {}),
		...(entry.inputPrice !== undefined ? { inputPrice: entry.inputPrice } : {}),
		...(entry.outputPrice !== undefined ? { outputPrice: entry.outputPrice } : {}),
		...(entry.cacheReadsPrice !== undefined ? { cacheReadsPrice: entry.cacheReadsPrice } : {}),
		...(entry.cacheWritesPrice !== undefined ? { cacheWritesPrice: entry.cacheWritesPrice } : {}),
		...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
		...(apiFormat !== undefined ? { apiFormat } : {}),
	})
}

function readStoredModelEntry(providerId: ProviderId, modelId: string): { exists: boolean; entry: StoredModelEntry | undefined } {
	const models = readModelsState().providers[providerSettingsProviderId(providerId)]?.models
	return {
		exists: models ? Object.hasOwn(models, modelId) : false,
		entry: models?.[modelId],
	}
}

function readModelOverrides(providerId: ProviderId, modelId: string): ModelSelectionOverrides | undefined {
	return toSelectionOverrides(readStoredModelEntry(providerId, modelId).entry)
}

function writeModelOverrides(providerId: ProviderId, modelId: string, overrides: ModelSelectionOverrides | undefined): void {
	const modelsPath = resolveModelsRegistryPath(getProviderSettingsManager())
	const state = readModelsFileSync(modelsPath)
	const provider = providerSettingsProviderId(providerId)
	const providerEntry = state.providers[provider] ?? {}
	const nextModels = { ...(providerEntry.models ?? {}) }
	const normalizedOverrides = normalizeModelSelectionOverrides(overrides)
	const storedEntry = normalizedOverrides ? toStoredModelEntry(normalizedOverrides) : undefined
	if (storedEntry && Object.keys(storedEntry).length > 0) {
		nextModels[modelId] = storedEntry
	} else {
		delete nextModels[modelId]
	}
	const nextProviderEntry = {
		...providerEntry,
		models: nextModels,
	}
	writeModelsFileSync(modelsPath, {
		...state,
		providers: {
			...state.providers,
			[provider]: nextProviderEntry,
		},
	})
	// ensureCustomProvidersLoadedSync is load-once per path and would no-op
	// here; sync the live registry explicitly so this write is visible to new
	// sessions without a restart.
	syncStoredProviderRegistration(provider, state.providers[provider], nextProviderEntry)
}

function applyModelOverrides(modelInfo: ModelInfo, overrides: ModelSelectionOverrides | undefined): ModelInfo {
	if (!overrides) {
		return modelInfo
	}
	const next: ModelInfo = { ...modelInfo }
	if (overrides.name !== undefined) next.name = overrides.name
	if (overrides.maxTokens !== undefined) next.maxTokens = overrides.maxTokens
	if (overrides.contextWindow !== undefined) next.contextWindow = overrides.contextWindow
	if (overrides.maxInputTokens !== undefined) next.maxInputTokens = overrides.maxInputTokens
	if (overrides.inputPrice !== undefined) next.inputPrice = overrides.inputPrice
	if (overrides.outputPrice !== undefined) next.outputPrice = overrides.outputPrice
	if (overrides.cacheReadsPrice !== undefined) next.cacheReadsPrice = overrides.cacheReadsPrice
	if (overrides.cacheWritesPrice !== undefined) next.cacheWritesPrice = overrides.cacheWritesPrice
	if (overrides.temperature !== undefined) next.temperature = overrides.temperature
	if (overrides.apiFormat !== undefined) next.apiFormat = overrides.apiFormat

	// Capability arrays are additive fallback flags: they can only enable
	// capabilities the base metadata lacks, never disable base capabilities
	// (an array authored for one purpose, e.g. prompt-cache, must not strip
	// unrelated base flags like vision). Explicit booleans win when both
	// representations are present.
	if (overrides.capabilities !== undefined) {
		if (overrides.capabilities.includes("images")) next.supportsImages = true
		if (overrides.capabilities.includes("prompt-cache")) next.supportsPromptCache = true
		if (overrides.capabilities.includes("reasoning")) next.supportsReasoning = true
		// Union into the preserved SDK capability list, but never fabricate
		// one from overrides alone: a user-authored partial list (e.g. just
		// ["prompt-cache"]) must stay non-authoritative about capabilities it
		// does not mention, and SDK checks fail open only when the list is
		// absent.
		if (next.capabilities !== undefined) {
			next.capabilities = [...new Set([...next.capabilities, ...overrides.capabilities])]
		}
	}
	if (overrides.supportsVision !== undefined) next.supportsImages = overrides.supportsVision
	if (overrides.supportsReasoning !== undefined) next.supportsReasoning = overrides.supportsReasoning
	return next
}

function readBaseModelInfoForProvider(providerId: ProviderId, modelId: string): ModelInfo | undefined {
	const sdkProviderId = toSdkProviderId(providerId)
	const generatedModelInfo = getGeneratedModelsForProvider(sdkProviderId)[modelId]
	if (isModelInfo(generatedModelInfo)) {
		return generatedModelInfo
	}
	if (generatedModelInfo) {
		try {
			return adaptSdkModelInfo(generatedModelInfo)
		} catch {
			return undefined
		}
	}

	const collectionModelInfo = MODEL_COLLECTIONS_BY_PROVIDER_ID[sdkProviderId]?.models[modelId]
	if (isModelInfo(collectionModelInfo)) {
		return collectionModelInfo
	}
	if (collectionModelInfo) {
		try {
			return adaptSdkModelInfo(collectionModelInfo)
		} catch {
			return undefined
		}
	}

	return undefined
}

interface BaseModelInfoCandidate {
	modelInfo: ModelInfo
	source: "catalog" | "fallback"
}

/**
 * Resolve a selection's metadata. `liveCatalogHint` is the exact live entry
 * the user picked in the catalog, so it wins over the static SDK catalog.
 */
function resolveSelection(selection: ModelSelection, liveCatalogHint?: ModelInfo): ResolvedModelSelection {
	const overrides = normalizeModelSelectionOverrides(
		selection.overrides ?? readModelOverrides(selection.providerId, selection.modelId),
	)
	const catalogModelInfo = readBaseModelInfoForProvider(selection.providerId, selection.modelId)
	const liveCatalogCandidate: BaseModelInfoCandidate | undefined = liveCatalogHint
		? { modelInfo: liveCatalogHint, source: "catalog" }
		: undefined
	const staticCatalogCandidate: BaseModelInfoCandidate | undefined = catalogModelInfo
		? { modelInfo: catalogModelInfo, source: "catalog" }
		: undefined
	const base =
		liveCatalogCandidate ??
		staticCatalogCandidate ??
		({ modelInfo: fallbackModelInfo(selection.modelId), source: "fallback" } satisfies BaseModelInfoCandidate)
	return {
		...selection,
		overrides,
		modelInfoSource: base.source,
		baseModelInfo: base.modelInfo,
		modelInfo: sanitizeResolvedModelInfo(applyModelOverrides(base.modelInfo, overrides)),
	}
}

export function resolveRuntimeModelSelection(providerId: ProviderId, modelId: string): ResolvedModelSelection {
	return resolveSelection({ providerId, modelId })
}

function readSelectionFromProviderSettings(providerId: ProviderId): ResolvedModelSelection | undefined {
	const modelId = readProviderSettingsModelId(providerId)
	if (!modelId) {
		return undefined
	}

	return resolveSelection({ providerId, modelId })
}

function getProviderSettings(providerId: ProviderId): ProviderSettingsRecord {
	const settings = getProviderSettingsManager().getProviderSettings(providerSettingsProviderId(providerId))
	return isRecord(settings) ? settings : {}
}

function saveProviderSettings(providerId: ProviderId, next: ProviderSettingsRecord): void {
	const provider = providerSettingsProviderId(providerId)
	getProviderSettingsManager().saveProviderSettings({ ...next, provider }, { setLastUsed: false })
}

function writeProviderSettingsFields(providerId: ProviderId, patch: ProviderConfigPatch): void {
	const existing = getProviderSettings(providerId)
	const next: ProviderSettingsRecord = { ...existing }

	for (const key of ["apiKey", "baseUrl", "apiLine", "headers", "region", "auth", "extras"] as const) {
		if (key in patch) {
			const value = typeof patch[key] === "string" ? patchStringValue(patch[key]) : patchValue(patch[key])
			if (value === undefined) {
				delete next[key]
			} else {
				next[key] = value
			}
		}
	}

	if ("gcp" in patch) {
		const gcpPatch = patch.gcp
		if (gcpPatch === null || gcpPatch === undefined) {
			delete next.gcp
		} else {
			const existingGcp = isRecord(next.gcp) ? next.gcp : {}
			const nextGcp: ProviderSettingsRecord = { ...existingGcp }
			for (const [key, value] of Object.entries(gcpPatch)) {
				if (typeof value === "string" && value.length === 0) {
					delete nextGcp[key]
				} else {
					nextGcp[key] = value
				}
			}
			if (Object.keys(nextGcp).length === 0) {
				delete next.gcp
			} else {
				next.gcp = nextGcp
			}
		}
	}

	if ("contextWindow" in patch) {
		const contextWindow = patch.contextWindow
		if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
			next.contextWindow = Math.floor(contextWindow)
		} else {
			delete next.contextWindow
		}
	}

	if ("aws" in patch) {
		const awsPatch = patch.aws
		if (awsPatch === null || awsPatch === undefined) {
			delete next.aws
		} else {
			const existingAws = isRecord(next.aws) ? next.aws : {}
			const nextAws: ProviderSettingsRecord = { ...existingAws }
			for (const [key, value] of Object.entries(awsPatch)) {
				if (typeof value === "string" && value.length === 0) {
					delete nextAws[key]
				} else {
					nextAws[key] = value
				}
			}
			next.aws = nextAws
		}
	}

	// Handle reasoning patch separately — maps to ProviderSettings.reasoning
	if ("reasoning" in patch) {
		const reasoningPatch = patch.reasoning
		if (reasoningPatch === null || reasoningPatch === undefined) {
			delete next.reasoning
		} else {
			const existingReasoning = (next as Record<string, unknown>).reasoning as Record<string, unknown> | undefined
			const merged: Record<string, unknown> = { ...(existingReasoning ?? {}) }
			if (reasoningPatch.enabled !== undefined) {
				merged.enabled = reasoningPatch.enabled
			}
			if (reasoningPatch.effort !== undefined) {
				merged.effort = reasoningPatch.effort === "none" ? undefined : reasoningPatch.effort
				// When effort is "none", disable reasoning
				if (reasoningPatch.effort === "none") {
					merged.enabled = false
				}
			}
			if (reasoningPatch.budgetTokens !== undefined) {
				merged.budgetTokens = reasoningPatch.budgetTokens
			}
			;(next as Record<string, unknown>).reasoning = merged
		}
	}

	saveProviderSettings(providerId, next)
}

function getModelIdKey(providerId: ProviderId, mode: Mode): keyof ApiConfiguration & SettingsKey {
	return getProviderModelIdKey(
		providerForStorage(providerId) ?? "anthropic",
		modelSettingsMode(mode),
	) as keyof ApiConfiguration & SettingsKey
}

function syncedModes(mode: Mode): Mode[] {
	return StateManager.get().getGlobalSettingsKey("planActSeparateModelsSetting") ? [mode] : ["plan", "act"]
}

function writeSelectionToState(providerId: ProviderId, mode: Mode, selection: ResolvedModelSelection): void {
	const updates: Partial<Record<SettingsKey, unknown>> = {}
	for (const targetMode of syncedModes(mode)) {
		updates[getModelIdKey(providerId, targetMode)] = selection.modelId
		selectionMemory.set(memoryKey(providerId, targetMode), { ...selection, providerId })
	}
	StateManager.get().setGlobalStateBatch(updates as never)
}

function writeSelectionToProviderSettings(providerId: ProviderId, selection: ModelSelection): void {
	const next: ProviderSettingsRecord = { ...getProviderSettings(providerId), model: selection.modelId }
	// Prune model metadata that earlier builds may have written to
	// providers.json.
	delete next.contextWindow
	delete next.maxTokens

	saveProviderSettings(providerId, next)
}

function readSelectionFromState(providerId: ProviderId, mode: Mode): ResolvedModelSelection | undefined {
	const apiConfiguration = StateManager.get().getApiConfiguration()
	const modelId = apiConfiguration[getModelIdKey(providerId, mode)]
	const rememberedSelection = selectionMemory.get(memoryKey(providerId, mode))
	const providerSettingsSelection = readSelectionFromProviderSettings(providerId)
	const activeProvider = mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider
	const provider = providerForStorage(providerId)
	if (activeProvider !== provider) {
		return rememberedSelection ?? providerSettingsSelection
	}

	if (typeof modelId !== "string" || modelId.length === 0) {
		return rememberedSelection ?? providerSettingsSelection
	}

	if (!isKnownModelIdForProvider(providerId, modelId)) {
		return rememberedSelection ?? providerSettingsSelection
	}

	if (!rememberedSelection || rememberedSelection.modelId !== modelId) {
		return providerSettingsSelection
	}
	return rememberedSelection
}

/**
 * Create a {@link ProviderConfigStore} backed by StateManager and the SDK
 * ProviderSettingsManager singleton. Writes update in-memory state before
 * returning; disk persistence follows the backing stores' existing policies.
 */
export function createProviderConfigStore(): ProviderConfigStore {
	const listeners = new Set<ProviderConfigChangeListener>()
	const emit = (event: ProviderConfigChange): void => {
		for (const listener of listeners) {
			listener(event)
		}
	}

	return {
		read(providerId: ProviderId): EffectiveProviderConfig {
			return { ...buildEffectiveProviderConfig(providerId) }
		},

		readSelection(providerId: ProviderId, mode: Mode): ResolvedModelSelection | undefined {
			return readSelectionFromState(providerId, modelSettingsMode(mode))
		},

		subscribe(listener: ProviderConfigChangeListener): Disposable {
			listeners.add(listener)
			return { dispose: () => listeners.delete(listener) }
		},

		write(providerId: ProviderId, patch: ProviderConfigPatch): EffectiveProviderConfig {
			const sanitizedPatch = sanitizeApiKeyPatch(patch)
			writeProviderSettingsFields(providerId, sanitizedPatch)
			const config = this.read(providerId)
			emit({ kind: "fields", providerId, config })
			return config
		},

		commitSelection(providerId: ProviderId, anyMode: Mode, selection: ModelSelection, baseModelInfoHint?: ModelInfo): void {
			// Ask mode has no model selection of its own: it runs on act mode's.
			const mode = modelSettingsMode(anyMode)
			writeSelectionToProviderSettings(providerId, selection)
			if (selection.overrides !== undefined) {
				writeModelOverrides(providerId, selection.modelId, selection.overrides)
			}
			// Prefer metadata resolved by the host catalog for this commit.
			const resolvedSelection = resolveSelection({ providerId, modelId: selection.modelId }, baseModelInfoHint)
			writeSelectionToState(providerId, mode, resolvedSelection)
			emit({ kind: "selection", providerId, mode, selection: resolvedSelection })
		},
	}
}
