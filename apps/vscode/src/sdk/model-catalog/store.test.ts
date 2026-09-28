import { syncStoredProviderRegistration } from "@plinycode/core"
import { type ApiConfiguration, type ModelInfo } from "@shared/api"
import { ApiFormat } from "@shared/proto/cline/models"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderConfigChange } from "./contracts"
import { parseProviderId } from "./provider-id"

const mocks = vi.hoisted(() => {
	type MockApiConfiguration = ApiConfiguration & { planActSeparateModelsSetting?: boolean }
	let apiConfiguration: MockApiConfiguration = {}
	let providerSettingsById: Record<string, Record<string, unknown>> = {}
	let generatedModelsByProvider: Record<string, Record<string, ModelInfo>> = {}
	let modelsFile: { version: 1; providers: Record<string, { models?: Record<string, Record<string, unknown>> }> } = {
		version: 1,
		providers: {},
	}
	const saveProviderSettings = vi.fn((settings: Record<string, unknown>, _options?: { setLastUsed?: boolean }) => {
		const provider = settings.provider
		if (typeof provider !== "string") {
			throw new Error("provider is required")
		}
		providerSettingsById[provider] = { ...settings }
		return { version: 1, providers: {} }
	})

	return {
		reset(): void {
			apiConfiguration = {}
			providerSettingsById = {}
			generatedModelsByProvider = {}
			modelsFile = { version: 1, providers: {} }
			saveProviderSettings.mockClear()
		},
		setApiConfiguration(value: MockApiConfiguration): void {
			apiConfiguration = { ...value }
		},
		setProviderSettings(value: Record<string, Record<string, unknown>>): void {
			providerSettingsById = { ...value }
		},
		setGeneratedModels(providerId: string, models: Record<string, ModelInfo>): void {
			generatedModelsByProvider = { ...generatedModelsByProvider, [providerId]: models }
		},
		getGeneratedModels(providerId: string): Record<string, ModelInfo> {
			return generatedModelsByProvider[providerId] ?? {}
		},
		getSavedProviderSettings(providerId: string): Record<string, unknown> | undefined {
			return providerSettingsById[providerId]
		},
		getApiConfiguration(): MockApiConfiguration {
			return { ...apiConfiguration }
		},
		getSaveProviderSettingsMock(): typeof saveProviderSettings {
			return saveProviderSettings
		},
		getModelsFile() {
			return modelsFile
		},
		setModelsFile(value: typeof modelsFile): void {
			modelsFile = value
		},
		getStateManager() {
			return {
				getApiConfiguration: () => ({ ...apiConfiguration }),
				getGlobalSettingsKey: (key: keyof MockApiConfiguration) => apiConfiguration[key],
				setSecret: (key: keyof MockApiConfiguration, value: unknown) => {
					apiConfiguration = { ...apiConfiguration, [key]: value }
				},
				setGlobalState: (key: keyof MockApiConfiguration, value: unknown) => {
					apiConfiguration = { ...apiConfiguration, [key]: value }
				},
				setGlobalStateBatch: (updates: MockApiConfiguration) => {
					apiConfiguration = { ...apiConfiguration, ...updates }
				},
			}
		},
		getProviderSettingsManager() {
			return {
				getProviderSettings: (providerId: string) => providerSettingsById[providerId],
				saveProviderSettings,
			}
		},
	}
})

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: { get: mocks.getStateManager },
}))

vi.mock("../provider-migration", () => ({
	getProviderSettingsManager: mocks.getProviderSettingsManager,
}))

vi.mock("@plinycode/core", () => ({
	isPrivateModelCatalogProvider: () => false,
	syncStoredProviderRegistration: vi.fn(),
	readModelsFileSync: vi.fn(() => mocks.getModelsFile()),
	resolveModelsRegistryPath: vi.fn(() => "/tmp/models.json"),
	writeModelsFileSync: vi.fn((_filePath: string, state: ReturnType<typeof mocks.getModelsFile>) => mocks.setModelsFile(state)),
}))

vi.mock("@plinycode/llms", () => ({
	getGeneratedModelsForProvider: vi.fn((providerId: string) => mocks.getGeneratedModels(providerId)),
	MODEL_COLLECTIONS_BY_PROVIDER_ID: {},
}))

const modelInfoA: ModelInfo = {
	name: "Model A",
	contextWindow: 128_000,
	maxTokens: 8_192,
	supportsPromptCache: true,
	apiFormat: ApiFormat.OPENAI_RESPONSES,
}

const modelInfoB: ModelInfo = {
	name: "Model B",
	contextWindow: 64_000,
	maxTokens: 4_096,
	supportsPromptCache: false,
}

function selectionFromModelInfo(providerId: ReturnType<typeof parseProviderId>, modelId: string, modelInfo: ModelInfo) {
	const capabilities: string[] = []
	if (modelInfo.supportsPromptCache) capabilities.push("prompt-cache")
	if (modelInfo.supportsImages) capabilities.push("images")
	if (modelInfo.supportsReasoning) capabilities.push("reasoning")
	return {
		providerId,
		modelId,
		overrides: {
			name: modelInfo.name,
			contextWindow: modelInfo.contextWindow,
			maxTokens: modelInfo.maxTokens,
			...(modelInfo.apiFormat !== undefined ? { apiFormat: modelInfo.apiFormat } : {}),
			...(capabilities.length > 0 ? { capabilities } : {}),
		},
	}
}

function expectResolvedSelection(
	actual: unknown,
	selection: ReturnType<typeof selectionFromModelInfo>,
	modelInfo: ModelInfo,
): void {
	expect(actual).toMatchObject({
		providerId: selection.providerId,
		modelId: selection.modelId,
		overrides: selection.overrides,
		modelInfo,
	})
}

describe("createProviderConfigStore", () => {
	beforeEach(() => {
		mocks.reset()
		vi.clearAllMocks()
		vi.resetModules()
	})

	it("round-trips write then read with fresh structurally equal objects", async () => {
		const { createProviderConfigStore } = await import("./store")
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")

		const written = store.write(providerId, { apiKey: "pliny-key" })
		const firstRead = store.read(providerId)
		const secondRead = store.read(providerId)

		expect(written).toEqual({ providerId, apiKey: "pliny-key" })
		expect(firstRead).toEqual(written)
		expect(secondRead).toEqual(firstRead)
		expect(secondRead).not.toBe(firstRead)
	})

	it("clears string fields from providers.json when they are written as empty strings", async () => {
		const { createProviderConfigStore } = await import("./store")
		mocks.setProviderSettings({ pliny: { provider: "pliny", apiKey: "existing-key", baseUrl: "https://custom.example" } })
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")

		store.write(providerId, { baseUrl: "" })

		expect(mocks.getSavedProviderSettings("pliny")).toEqual({ provider: "pliny", apiKey: "existing-key" })
		expect(store.read(providerId).baseUrl).toBeUndefined()
	})

	// Pasted API keys can carry invisible clipboard artifacts (surrounding
	// whitespace, newlines, zero-width characters). The masked key field hides
	// them from the user and the provider rejects the key with a 401 that
	// looks identical to a genuinely wrong key, so the write boundary must
	// strip them before the value reaches either backing store.
	it("sanitizes pasted API keys before writing them", async () => {
		const { createProviderConfigStore } = await import("./store")
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")

		store.write(providerId, { apiKey: " \u200b\ufeffpliny-key\u200d \n" })

		expect(mocks.getSavedProviderSettings("pliny")).toEqual({ provider: "pliny", apiKey: "pliny-key" })
		expect(store.read(providerId).apiKey).toBe("pliny-key")
	})

	it("treats a whitespace-only API key as a clear", async () => {
		const { createProviderConfigStore } = await import("./store")
		mocks.setProviderSettings({ pliny: { provider: "pliny", apiKey: "existing-key" } })
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")

		store.write(providerId, { apiKey: " \n " })

		expect(mocks.getSavedProviderSettings("pliny")).toEqual({ provider: "pliny" })
		expect(store.read(providerId).apiKey).toBeUndefined()
	})

	it("round-trips commitSelection then readSelection for provider-specific model info", async () => {
		const { createProviderConfigStore } = await import("./store")
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")
		const selection = selectionFromModelInfo(providerId, "anthropic/claude-sonnet-4", modelInfoA)

		store.commitSelection(providerId, "act", selection)

		expectResolvedSelection(store.readSelection(providerId, "act"), selection, modelInfoA)
		expect(mocks.getModelsFile().providers.pliny?.models?.["anthropic/claude-sonnet-4"]).toMatchObject({
			name: "Model A",
			contextWindow: 128_000,
			maxTokens: 8_192,
			apiFormat: "openai-responses",
			capabilities: ["prompt-cache"],
		})
	})

	it("round-trips generic provider selections using the in-process modelInfo envelope", async () => {
		const { createProviderConfigStore } = await import("./store")
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")
		const selection = selectionFromModelInfo(providerId, "snps-provider/kimi-k2.6", modelInfoA)

		store.commitSelection(providerId, "act", selection)

		expectResolvedSelection(store.readSelection(providerId, "act"), selection, modelInfoA)
	})

	it("hydrates a generic provider selection from providers.json after reload", async () => {
		const { createProviderConfigStore } = await import("./store")
		mocks.setProviderSettings({ pliny: { provider: "pliny", model: "manual-pliny-model" } })
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")

		expect(store.readSelection(providerId, "act")).toEqual({
			providerId,
			modelId: "manual-pliny-model",
			modelInfoSource: "fallback",
			baseModelInfo: expect.objectContaining({ name: "manual-pliny-model" }),
			modelInfo: expect.objectContaining({
				name: "manual-pliny-model",
				supportsPromptCache: false,
			}),
		})
	})

	it("preserves per-model OpenAI Compatible overrides when switching models without new overrides", async () => {
		const { createProviderConfigStore } = await import("./store")
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")
		const modelASelection = selectionFromModelInfo(providerId, "model-a", modelInfoA)

		store.commitSelection(providerId, "act", modelASelection)
		store.commitSelection(providerId, "act", { providerId, modelId: "model-b" })
		store.commitSelection(providerId, "act", { providerId, modelId: "model-a" })

		expectResolvedSelection(store.readSelection(providerId, "act"), modelASelection, modelInfoA)
		expect(mocks.getModelsFile().providers.pliny?.models?.["model-a"]).toMatchObject({
			name: "Model A",
			maxTokens: 8_192,
			contextWindow: 128_000,
		})
	})

	it("deletes a model entry when an explicit replacement override set is empty", async () => {
		const { createProviderConfigStore } = await import("./store")
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")

		store.commitSelection(providerId, "act", {
			providerId,
			modelId: "custom-model",
			overrides: {
				apiFormat: ApiFormat.OPENAI_RESPONSES,
				capabilities: ["tools", "streaming"],
				temperature: 0.2,
			},
		})
		expect(mocks.getModelsFile().providers.pliny?.models?.["custom-model"]).toMatchObject({
			apiFormat: "openai-responses",
			capabilities: ["tools", "streaming"],
			temperature: 0.2,
		})

		store.commitSelection(providerId, "act", { providerId, modelId: "custom-model", overrides: {} })

		expect(mocks.getModelsFile().providers.pliny?.models?.["custom-model"]).toBeUndefined()
		expect(store.readSelection(providerId, "act")?.overrides).toBeUndefined()
	})

	it("replaces an existing model override set instead of merging stale fields", async () => {
		const { createProviderConfigStore } = await import("./store")
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")

		store.commitSelection(providerId, "act", {
			providerId,
			modelId: "custom-model",
			overrides: { apiFormat: ApiFormat.OPENAI_RESPONSES, inputPrice: 1, temperature: 0.2 },
		})
		store.commitSelection(providerId, "act", {
			providerId,
			modelId: "custom-model",
			overrides: { temperature: 0.4 },
		})

		expect(mocks.getModelsFile().providers.pliny?.models?.["custom-model"]).toEqual({ temperature: 0.4 })
		expect(store.readSelection(providerId, "act")?.overrides).toEqual({ temperature: 0.4 })
	})

	it.each([
		[ApiFormat.OPENAI_CHAT, "default"],
		[ApiFormat.R1_CHAT, "r1"],
		[ApiFormat.OPENAI_RESPONSES, "openai-responses"],
	] as const)("round-trips supported apiFormat %s through models.json", async (apiFormat, storedApiFormat) => {
		const { createProviderConfigStore } = await import("./store")
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")

		store.commitSelection(providerId, "act", {
			providerId,
			modelId: "custom-model",
			overrides: { apiFormat },
		})

		expect(mocks.getModelsFile().providers.pliny?.models?.["custom-model"]).toEqual({
			apiFormat: storedApiFormat,
		})
		expect(store.readSelection(providerId, "act")?.overrides).toEqual({ apiFormat })
	})

	it("normalizes invalid override values before storage and resolved legacy state", async () => {
		const { createProviderConfigStore } = await import("./store")
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")

		store.commitSelection(providerId, "act", {
			providerId,
			modelId: "custom-model",
			overrides: {
				name: "Custom model",
				maxTokens: -1,
				contextWindow: Number.POSITIVE_INFINITY,
				maxInputTokens: 0,
				capabilities: ["tools", "tools", "vision", "unknown"],
				supportsVision: false,
				supportsReasoning: false,
				inputPrice: Number.NaN,
				outputPrice: 2,
				cacheReadsPrice: 0,
				cacheWritesPrice: -1,
				temperature: -1,
				apiFormat: 999 as ApiFormat,
			},
		})

		expect(mocks.getModelsFile().providers.pliny?.models?.["custom-model"]).toEqual({
			name: "Custom model",
			capabilities: ["tools"],
			supportsVision: false,
			supportsReasoning: false,
			outputPrice: 2,
			cacheReadsPrice: 0,
		})
		const selection = store.readSelection(providerId, "act")
		expect(selection?.overrides).toEqual({
			name: "Custom model",
			capabilities: ["tools"],
			supportsVision: false,
			supportsReasoning: false,
			outputPrice: 2,
			cacheReadsPrice: 0,
		})
		expect(selection?.modelInfo.maxTokens).toBeUndefined()
		expect(selection?.modelInfo.temperature).toBe(0)
		expect(syncStoredProviderRegistration).toHaveBeenCalledTimes(1)
	})

	it("deletes a stored entry when normalization removes every replacement field", async () => {
		const { createProviderConfigStore } = await import("./store")
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")

		store.commitSelection(providerId, "act", {
			providerId,
			modelId: "custom-model",
			overrides: { temperature: 0.2 },
		})
		store.commitSelection(providerId, "act", {
			providerId,
			modelId: "custom-model",
			overrides: {
				maxTokens: -1,
				contextWindow: 0,
				capabilities: ["vision", "unknown"],
				inputPrice: Number.NaN,
				temperature: -1,
				apiFormat: 999 as ApiFormat,
			},
		})

		expect(mocks.getModelsFile().providers.pliny?.models?.["custom-model"]).toBeUndefined()
		expect(store.readSelection(providerId, "act")?.overrides).toBeUndefined()
		expect(syncStoredProviderRegistration).toHaveBeenCalledTimes(2)
	})

	it("normalizes invalid values already present in models.json on read", async () => {
		const { createProviderConfigStore } = await import("./store")
		mocks.setProviderSettings({
			pliny: { provider: "pliny", model: "custom-model" },
		})
		mocks.setModelsFile({
			version: 1,
			providers: {
				pliny: {
					models: {
						"custom-model": {
							maxTokens: -1,
							contextWindow: 64_000,
							inputPrice: -2,
							temperature: -1,
							capabilities: ["tools"],
						},
					},
				},
			},
		})
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")

		const selection = store.readSelection(providerId, "act")

		expect(selection?.overrides).toEqual({ contextWindow: 64_000, capabilities: ["tools"] })
		expect(selection?.modelInfo.maxTokens).toBeUndefined()
		expect(selection?.modelInfo.temperature).toBe(0)
		expect(syncStoredProviderRegistration).not.toHaveBeenCalled()
	})

	it("lets explicit capability booleans win over capability arrays", async () => {
		const { createProviderConfigStore } = await import("./store")
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")

		store.commitSelection(providerId, "act", {
			providerId,
			modelId: "custom-model",
			overrides: {
				apiFormat: ApiFormat.OPENAI_RESPONSES,
				capabilities: ["images", "prompt-cache", "reasoning"],
				supportsVision: false,
				supportsReasoning: false,
			},
		})
		let selection = store.readSelection(providerId, "act")
		expect(selection?.modelInfo).toMatchObject({
			supportsImages: false,
			supportsPromptCache: true,
			supportsReasoning: false,
			apiFormat: ApiFormat.OPENAI_RESPONSES,
		})

		store.commitSelection(providerId, "act", {
			providerId,
			modelId: "custom-model",
			overrides: {
				apiFormat: ApiFormat.OPENAI_RESPONSES,
				capabilities: ["prompt-cache"],
				supportsVision: true,
			},
		})
		selection = store.readSelection(providerId, "act")
		expect(selection?.modelInfo).toMatchObject({
			supportsImages: true,
			supportsPromptCache: true,
			apiFormat: ApiFormat.OPENAI_RESPONSES,
		})
	})

	it("keeps Plan and Act model ids independent in state when separate models are enabled", async () => {
		const { createProviderConfigStore } = await import("./store")
		mocks.setApiConfiguration({ planActSeparateModelsSetting: true })
		mocks.setProviderSettings({
			pliny: {
				provider: "pliny",
				apiKey: "pliny-key",
			},
		})
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")
		const planSelection = selectionFromModelInfo(providerId, "plan-pliny-model", modelInfoA)
		const actSelection = selectionFromModelInfo(providerId, "act-pliny-model", modelInfoB)

		store.commitSelection(providerId, "plan", planSelection)
		store.commitSelection(providerId, "act", actSelection)

		expectResolvedSelection(store.readSelection(providerId, "plan"), planSelection, modelInfoA)
		expectResolvedSelection(store.readSelection(providerId, "act"), actSelection, modelInfoB)
		expect(mocks.getApiConfiguration()).toMatchObject({
			planModeApiModelId: "plan-pliny-model",
			actModeApiModelId: "act-pliny-model",
		})
		expect(mocks.getSavedProviderSettings("pliny")).toMatchObject({
			provider: "pliny",
			apiKey: "pliny-key",
			model: "act-pliny-model",
		})
	})

	it("mirrors a selection to both modes when separate models are disabled", async () => {
		const { createProviderConfigStore } = await import("./store")
		mocks.setApiConfiguration({ planActSeparateModelsSetting: false })
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")
		const selection = selectionFromModelInfo(providerId, "shared-pliny-model", modelInfoA)

		store.commitSelection(providerId, "act", selection)

		expectResolvedSelection(store.readSelection(providerId, "plan"), selection, modelInfoA)
		expectResolvedSelection(store.readSelection(providerId, "act"), selection, modelInfoA)
		expect(mocks.getApiConfiguration()).toMatchObject({
			planModeApiModelId: "shared-pliny-model",
			actModeApiModelId: "shared-pliny-model",
		})
		expect(mocks.getSavedProviderSettings("pliny")).toMatchObject({
			provider: "pliny",
			model: "shared-pliny-model",
		})
	})

	it("keeps Plan and Act selections independent and mirrors the latest selection to provider settings", async () => {
		const { createProviderConfigStore } = await import("./store")
		mocks.setApiConfiguration({ planActSeparateModelsSetting: true })
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")
		const planSelection = selectionFromModelInfo(providerId, "provider/model-a", modelInfoA)
		const actSelection = selectionFromModelInfo(providerId, "provider/model-b", modelInfoB)

		store.commitSelection(providerId, "plan", planSelection)
		store.commitSelection(providerId, "act", actSelection)

		expectResolvedSelection(store.readSelection(providerId, "plan"), planSelection, modelInfoA)
		expectResolvedSelection(store.readSelection(providerId, "act"), actSelection, modelInfoB)
		expect(mocks.getSavedProviderSettings("pliny")).toMatchObject({
			provider: "pliny",
			model: "provider/model-b",
		})
		expect(mocks.getSavedProviderSettings("pliny")).not.toHaveProperty("contextWindow")
		expect(mocks.getSavedProviderSettings("pliny")).not.toHaveProperty("maxTokens")
	})

	it("updates providers.json model with setLastUsed false when planActSeparateModelsSetting=false", async () => {
		const { createProviderConfigStore } = await import("./store")
		mocks.setApiConfiguration({ planActSeparateModelsSetting: false })
		mocks.setProviderSettings({
			pliny: { provider: "pliny", apiKey: "existing-key", contextWindow: 64_000, maxTokens: 4_096 },
		})
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")
		const selection = selectionFromModelInfo(providerId, "provider/model-a", modelInfoA)

		store.commitSelection(providerId, "act", selection)

		expect(mocks.getSavedProviderSettings("pliny")).toMatchObject({
			provider: "pliny",
			apiKey: "existing-key",
			model: "provider/model-a",
		})
		expect(mocks.getSavedProviderSettings("pliny")).not.toHaveProperty("contextWindow")
		expect(mocks.getSavedProviderSettings("pliny")).not.toHaveProperty("maxTokens")
		expect(mocks.getSaveProviderSettingsMock()).toHaveBeenCalledWith(expect.objectContaining({ model: "provider/model-a" }), {
			setLastUsed: false,
		})
	})

	it("subscribers fire synchronously and multiple writes emit events in order", async () => {
		const { createProviderConfigStore } = await import("./store")
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")
		const events: ProviderConfigChange[] = []
		let fired = false

		store.subscribe((event) => {
			fired = true
			events.push(event)
		})

		const first = store.write(providerId, { apiKey: "first" })
		expect(fired).toBe(true)
		const second = store.write(providerId, { apiKey: "second" })

		expect(events).toEqual([
			{ kind: "fields", providerId, config: first },
			{ kind: "fields", providerId, config: second },
		])
	})

	it("write emits fields, commitSelection emits selection, and write never emits selection", async () => {
		const { createProviderConfigStore } = await import("./store")
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")
		const events: ProviderConfigChange[] = []
		const selection = selectionFromModelInfo(providerId, "provider/model-a", modelInfoA)

		store.subscribe((event) => events.push(event))
		store.write(providerId, { apiKey: "openrouter-key" })
		store.commitSelection(providerId, "act", selection)

		expect(events.map((event) => event.kind)).toEqual(["fields", "selection"])
		expect(events[0]).toMatchObject({ kind: "fields", providerId })
		expect(events[1]).toEqual({
			kind: "selection",
			providerId,
			mode: "act",
			selection: store.readSelection(providerId, "act"),
		})
	})

	it("dispose unregisters listeners", async () => {
		const { createProviderConfigStore } = await import("./store")
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")
		const listener = vi.fn()
		const disposable = store.subscribe(listener)

		disposable.dispose()
		store.write(providerId, { apiKey: "pliny-key" })

		expect(listener).not.toHaveBeenCalled()
	})

	// Contract test against the REAL SDK schemas (imported by relative path,
	// bypassing the @plinycode/core mock above): the store's converters must pass
	// every SDK capability through, and a fully-populated stored entry must
	// parse under the schema `writeModelsFileSync` enforces in production.
	it("round-trips every SDK model capability and a full override set under the real stored-entry schema", async () => {
		const { ModelCapabilitySchema } = await import("@plinycode/shared")
		// vi.importActual bypasses the @plinycode/core mock above and resolves via
		// the vitest alias to the stub, which re-exports the real schema.
		const { StoredModelEntrySchema } = (await vi.importActual("@plinycode/core")) as {
			StoredModelEntrySchema: { parse(input: unknown): unknown }
		}
		const { createProviderConfigStore } = await import("./store")
		const store = createProviderConfigStore()
		const providerId = parseProviderId("pliny")

		store.commitSelection(providerId, "act", {
			providerId,
			modelId: "contract-model",
			overrides: {
				name: "Contract Model",
				maxTokens: 1024,
				contextWindow: 200_000,
				maxInputTokens: 100_000,
				capabilities: [...ModelCapabilitySchema.options],
				supportsVision: true,
				supportsAttachments: true,
				supportsReasoning: true,
				inputPrice: 0.5,
				outputPrice: 1.5,
				cacheReadsPrice: 0.1,
				cacheWritesPrice: 0.2,
				temperature: 0.7,
				apiFormat: ApiFormat.OPENAI_RESPONSES,
			},
		})

		const entry = mocks.getModelsFile().providers.pliny?.models?.["contract-model"]
		expect(entry).toBeDefined()
		// No SDK capability may be silently stripped by the store's converter.
		expect([...(entry?.capabilities as string[])].sort()).toEqual([...ModelCapabilitySchema.options].sort())
		// The entry written by the extension must satisfy the real schema that
		// the SDK's writeModelsFileSync enforces.
		expect(() => StoredModelEntrySchema.parse(entry)).not.toThrow()
	})
})
