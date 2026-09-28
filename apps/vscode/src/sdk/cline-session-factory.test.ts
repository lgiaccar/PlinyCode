import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { CoreSessionConfig } from "@plinycode/core"
import * as LlmsModels from "@plinycode/llms"
import { ApiFormat } from "@shared/proto/cline/models"
import { Logger } from "@shared/services/Logger"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	buildResumeSessionInput,
	buildSessionConfig,
	buildStartSessionInput,
	createHistoryItemFromSession,
	getDefaultModelIdForProvider,
	getHistoryItemById,
	normalizeProviderReasoningSettings,
	normalizeSdkBaseUrl,
	resolveApiKey,
	resolveProviderId,
	updateHistoryItem,
} from "./cline-session-factory"
import { parseProviderId } from "./model-catalog/provider-id"
import { createProviderConfigStore } from "./model-catalog/store"

const mocks = vi.hoisted(() => {
	const providerSettingsManager = {
		getFilePath: vi.fn(() => path.join(tempDir, "settings", "providers.json")),
		getLastUsedProviderSettings: vi.fn(() => undefined),
		getProviderSettings: vi.fn((_providerId?: string) => undefined),
		saveProviderSettings: vi.fn(),
	}

	return {
		getDistinctId: vi.fn(() => "test-distinct-id"),
		getProviderSettingsManager: vi.fn(() => providerSettingsManager),
		providerSettingsManager,
		stateManager: {
			getApiConfiguration: vi.fn(() => ({
				actModeApiProvider: "pliny",
				actModeApiModelId: "snps-provider/kimi-k2.6",
			})),
			getGlobalSettingsKey: vi.fn((key: string): boolean | undefined => {
				if (key === "subagentsEnabled" || key === "useAutoCondense") {
					return false
				}
				return undefined
			}),
			setGlobalStateBatch: vi.fn(),
			setGlobalState: vi.fn(),
			setSecret: vi.fn(),
		},
	}
})

// The ESM namespace object for `@plinycode/llms` has non-configurable
// properties, so `vi.spyOn(LlmsModels, ...)` throws "Cannot redefine
// property". Re-export the real module with `getModelsForProvider` wrapped in
// a vi.fn that delegates to the original, so tests can spy on it.
vi.mock("@plinycode/llms", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@plinycode/llms")>()
	return {
		...actual,
		getModelsForProvider: vi.fn(actual.getModelsForProvider),
	}
})

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => mocks.stateManager,
	},
}))

vi.mock("@/services/logging/distinctId", () => ({
	getDistinctId: mocks.getDistinctId,
}))

vi.mock("./provider-migration", () => ({
	getProviderSettingsManager: mocks.getProviderSettingsManager,
}))

vi.mock("@shared/services/Logger", () => ({
	Logger: {
		debug: vi.fn(),
		log: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}))

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDir: string
const previousGlobalSettingsPath = process.env.CLINE_GLOBAL_SETTINGS_PATH
const previousDataDir = process.env.CLINE_DATA_DIR

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-session-factory-"))
	process.env.CLINE_DATA_DIR = tempDir
	process.env.CLINE_GLOBAL_SETTINGS_PATH = path.join(tempDir, "global-settings.json")
	vi.clearAllMocks()
	LlmsModels.resetRegistry()
	mocks.stateManager.getApiConfiguration.mockReturnValue({
		actModeApiProvider: "pliny",
		actModeApiModelId: "snps-provider/kimi-k2.6",
	})
	mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
		if (key === "subagentsEnabled" || key === "useAutoCondense") {
			return false
		}
		return undefined
	})
	mocks.providerSettingsManager.getFilePath.mockReturnValue(path.join(tempDir, "settings", "providers.json"))
	mocks.providerSettingsManager.getLastUsedProviderSettings.mockReturnValue(undefined)
	mocks.providerSettingsManager.getProviderSettings.mockReturnValue(undefined)
	// clearAllMocks keeps implementations: re-pin the default so a test that
	// swaps in a real manager cannot leak it into later tests.
	mocks.getProviderSettingsManager.mockImplementation(() => mocks.providerSettingsManager)
})

afterEach(() => {
	process.env.CLINE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath
	process.env.CLINE_DATA_DIR = previousDataDir
	fs.rmSync(tempDir, { recursive: true, force: true })
})

function writeJson(filePath: string, data: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true })
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

function makeBaseConfig(overrides: Partial<CoreSessionConfig> = {}): CoreSessionConfig {
	return {
		providerId: "anthropic",
		modelId: "claude-sonnet-4-6",
		apiKey: "test-key",
		cwd: "/tmp/workspace",
		workspaceRoot: "/tmp/workspace",
		systemPrompt: "",
		mode: "act",
		enableTools: true,
		enableSpawnAgent: false,
		enableAgentTeams: false,
		...overrides,
	}
}

// ---------------------------------------------------------------------------
// provider/model defaults
// ---------------------------------------------------------------------------

describe("getDefaultModelIdForProvider", () => {
	it("uses the SDK provider catalog default", () => {
		expect(getDefaultModelIdForProvider("pliny")).toBe(
			LlmsModels.MODEL_COLLECTIONS_BY_PROVIDER_ID.pliny.provider.defaultModelId,
		)
	})

	it("returns undefined for unknown providers", () => {
		expect(getDefaultModelIdForProvider("unknown-provider")).toBeUndefined()
	})
})

describe("resolveProviderId", () => {
	it("returns pliny for the mode", () => {
		expect(resolveProviderId("act", { actModeApiProvider: "pliny" })).toBe("pliny")
		expect(resolveProviderId("plan", { planModeApiProvider: "pliny" })).toBe("pliny")
	})

	it("reads a provider stored by an older version as pliny", () => {
		expect(resolveProviderId("act", { actModeApiProvider: "anthropic" } as any)).toBe("pliny")
		expect(resolveProviderId("plan", { planModeApiProvider: "openai-compatible" } as any)).toBe("pliny")
		expect(resolveProviderId("act", undefined)).toBe("pliny")
	})
})

// ---------------------------------------------------------------------------
// buildStartSessionInput
// ---------------------------------------------------------------------------

describe("buildStartSessionInput", () => {
	it("does not forward the prompt to start()", () => {
		const config = makeBaseConfig()
		const input = {
			prompt: "Hello, world!",
			cwd: "/tmp/workspace",
		}

		const result = buildStartSessionInput(config, input)

		expect(result.config).toBe(config)
		expect(result.prompt).toBeUndefined()
		expect(result.interactive).toBe(true)
		expect(result.userImages).toBeUndefined()
		expect(result.userFiles).toBeUndefined()
	})

	it("includes images and files when provided", () => {
		const config = makeBaseConfig()
		const input = {
			prompt: "Look at this",
			images: ["image1.png", "image2.jpg"],
			files: ["file1.ts"],
			cwd: "/tmp/workspace",
		}

		const result = buildStartSessionInput(config, input)

		expect(result.userImages).toEqual(["image1.png", "image2.jpg"])
		expect(result.userFiles).toEqual(["file1.ts"])
	})

	it("always sets interactive to true", () => {
		const config = makeBaseConfig()
		const input = { cwd: "/tmp/workspace" }

		const result = buildStartSessionInput(config, input)

		expect(result.interactive).toBe(true)
	})

	it("handles undefined prompt", () => {
		const config = makeBaseConfig()
		const input = { cwd: "/tmp/workspace" }

		const result = buildStartSessionInput(config, input)

		expect(result.prompt).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// buildResumeSessionInput
// ---------------------------------------------------------------------------

describe("buildResumeSessionInput", () => {
	it("builds resume input with session ID and prompt", () => {
		const result = buildResumeSessionInput("session-123", "Continue the task")

		expect(result.sessionId).toBe("session-123")
		expect(result.prompt).toBe("Continue the task")
		expect(result.userImages).toBeUndefined()
		expect(result.userFiles).toBeUndefined()
	})

	it("includes images and files when provided", () => {
		const result = buildResumeSessionInput("session-123", "Look at this", ["img.png"], ["file.ts"])

		expect(result.userImages).toEqual(["img.png"])
		expect(result.userFiles).toEqual(["file.ts"])
	})
})

// ---------------------------------------------------------------------------
// normalizeSdkBaseUrl
// ---------------------------------------------------------------------------

describe("normalizeSdkBaseUrl", () => {
	it("treats blank base URLs as unset so SDK provider defaults can apply", () => {
		expect(normalizeSdkBaseUrl("pliny", "")).toBeUndefined()
		expect(normalizeSdkBaseUrl("pliny", "   ")).toBeUndefined()
	})

	it("preserves explicit user paths", () => {
		expect(normalizeSdkBaseUrl("pliny", " https://example.com/custom ")).toBe("https://example.com/custom")
	})
})

// ---------------------------------------------------------------------------
// normalizeProviderReasoningSettings
// ---------------------------------------------------------------------------

describe("normalizeProviderReasoningSettings", () => {
	it("does not emit reasoningEffort when thinking is disabled", () => {
		const result = normalizeProviderReasoningSettings({ enabled: false, effort: "medium" })

		expect(result).toEqual({ thinking: false })
	})

	it("treats effort none as disabled thinking", () => {
		const result = normalizeProviderReasoningSettings({ effort: "none" })

		expect(result).toEqual({ thinking: false })
	})

	it("passes enabled reasoning with a concrete effort", () => {
		const result = normalizeProviderReasoningSettings({ enabled: true, effort: "high" })

		expect(result).toEqual({ thinking: true, reasoningEffort: "high" })
	})

	it("leaves explicit effort-only settings enabled by SDK/provider defaults", () => {
		const result = normalizeProviderReasoningSettings({ effort: "medium" })

		expect(result).toEqual({ reasoningEffort: "medium" })
	})

	it("honors a migrated legacy budget as thinking-on with a derived effort", () => {
		expect(normalizeProviderReasoningSettings({ budgetTokens: 1024 })).toEqual({
			thinking: true,
			reasoningEffort: "low",
		})
		expect(normalizeProviderReasoningSettings({ budgetTokens: 6000 })).toEqual({
			thinking: true,
			reasoningEffort: "medium",
		})
		expect(normalizeProviderReasoningSettings({ budgetTokens: 32_767 })).toEqual({
			thinking: true,
			reasoningEffort: "high",
		})
	})

	it("derives an effort from the budget when enabled without an effort", () => {
		const result = normalizeProviderReasoningSettings({ enabled: true, budgetTokens: 4096 })

		expect(result).toEqual({ thinking: true, reasoningEffort: "medium" })
	})

	it("prefers an explicit effort over a stored budget", () => {
		const result = normalizeProviderReasoningSettings({ enabled: true, effort: "xhigh", budgetTokens: 1024 })

		expect(result).toEqual({ thinking: true, reasoningEffort: "xhigh" })
	})

	it("keeps disabled reasoning off even with a stored budget", () => {
		const result = normalizeProviderReasoningSettings({ enabled: false, budgetTokens: 4096 })

		expect(result).toEqual({ thinking: false })
	})
})

// ---------------------------------------------------------------------------
// buildSessionConfig
// ---------------------------------------------------------------------------

function mockPlinySettings(settings: Record<string, unknown>): void {
	mocks.providerSettingsManager.getProviderSettings.mockImplementation((providerId?: string) =>
		providerId === "pliny" ? ({ provider: "pliny", ...settings } as any) : undefined,
	)
}

describe("buildSessionConfig", () => {
	it("reads the Pliny API key from providers.json", () => {
		mockPlinySettings({ apiKey: " pliny-key " })

		expect(resolveApiKey("pliny")).toBe("pliny-key")
		expect(mocks.providerSettingsManager.getProviderSettings).toHaveBeenCalledWith("pliny")
	})

	it("builds a Pliny session with the key, model and base URL", async () => {
		mockPlinySettings({ apiKey: "pliny-key", baseUrl: "http://127.0.0.1:4141/v1" })

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerId).toBe("pliny")
		expect(config.modelId).toBe("snps-provider/kimi-k2.6")
		expect(config.apiKey).toBe("pliny-key")
		expect(config.baseUrl).toBe("http://127.0.0.1:4141/v1")
		expect(config.providerConfig).toMatchObject({
			providerId: "pliny",
			modelId: "snps-provider/kimi-k2.6",
			apiKey: "pliny-key",
			baseUrl: "http://127.0.0.1:4141/v1",
		})
	})

	it("runs on Pliny when an older version stored another provider", async () => {
		mockPlinySettings({ apiKey: "pliny-key" })
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "openrouter",
			actModeApiModelId: "snps-provider/GLM-5.2",
			openRouterApiKey: "openrouter-key",
		} as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerId).toBe("pliny")
		expect(config.modelId).toBe("snps-provider/GLM-5.2")
		expect(config.apiKey).toBe("pliny-key")
	})

	it("falls back to the Pliny catalog default when no model is stored", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({ actModeApiProvider: "pliny" } as any)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.modelId).toBe(LlmsModels.MODEL_COLLECTIONS_BY_PROVIDER_ID.pliny.provider.defaultModelId)
	})

	it("omits an empty apiKey from the provider config", async () => {
		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.apiKey).toBe("")
		expect(config.providerConfig).not.toHaveProperty("apiKey")
	})

	it("exposes knownModels at the top level so manual compaction can budget against the model catalog", async () => {
		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		const providerConfigKnownModels = (config.providerConfig as { knownModels?: Record<string, unknown> }).knownModels
		expect(providerConfigKnownModels).toBeDefined()
		expect(config.knownModels).toBe(providerConfigKnownModels)
	})

	it("keeps session creation non-fatal when known-model lookup fails", async () => {
		const lookupError = new Error("registry unavailable")
		const getModelsSpy = vi.spyOn(LlmsModels, "getModelsForProvider").mockRejectedValueOnce(lookupError)

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.providerConfig).not.toHaveProperty("knownModels")
		expect(Logger.warn).toHaveBeenCalledWith(
			"[SessionFactory] Failed to resolve known models for provider=pliny:",
			lookupError,
		)
		getModelsSpy.mockRestore()
	})

	it("uses model overrides from models.json for runtime request settings", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "pliny",
			actModeApiModelId: "custom-reasoner",
		} as any)
		createProviderConfigStore().commitSelection(parseProviderId("pliny"), "act", {
			providerId: parseProviderId("pliny"),
			modelId: "custom-reasoner",
			overrides: {
				name: "Custom Reasoner",
				contextWindow: 16_000,
				maxInputTokens: 15_000,
				maxTokens: 1_234,
				capabilities: ["images", "reasoning", "streaming", "tools"],
				supportsVision: false,
				supportsAttachments: true,
				supportsReasoning: false,
				temperature: 0,
				inputPrice: 1,
				outputPrice: 2,
				cacheReadsPrice: 0.1,
				cacheWritesPrice: 0.5,
				apiFormat: ApiFormat.OPENAI_RESPONSES,
			},
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })
		const knownModel = (config.providerConfig as any).knownModels["custom-reasoner"]

		expect(config.modelId).toBe("custom-reasoner")
		expect((config as any).maxTokensPerTurn).toBe(1_234)
		expect((config.providerConfig as any).maxOutputTokens).toBe(1_234)
		expect((config as any).temperature).toBe(0)
		expect(knownModel).toMatchObject({
			id: "custom-reasoner",
			name: "Custom Reasoner",
			contextWindow: 16_000,
			maxInputTokens: 15_000,
			maxTokens: 1_234,
			capabilities: ["streaming", "tools", "files"],
			apiFormat: "openai-responses",
			temperature: 0,
			pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 },
		})
	})

	it("defaults tool-calling on for an overridden model without an SDK capability list", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "pliny",
			actModeApiModelId: "mock/custom-model",
		} as any)
		createProviderConfigStore().commitSelection(parseProviderId("pliny"), "act", {
			providerId: parseProviderId("pliny"),
			modelId: "mock/custom-model",
			overrides: { name: "Mock Custom Model", contextWindow: 16_000, supportsReasoning: true },
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })
		const knownModel = (config.providerConfig as any).knownModels["mock/custom-model"]

		// A non-empty capabilities array without "tools" reads as "cannot call
		// tools" to the SDK runtime, which would silently drop every tool.
		expect(knownModel.capabilities).toEqual(expect.arrayContaining(["reasoning", "tools"]))
	})

	it("keeps -1 override values out of request settings and fallback knownModels", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "pliny",
			actModeApiModelId: "custom-reasoner",
		} as any)
		createProviderConfigStore().commitSelection(parseProviderId("pliny"), "act", {
			providerId: parseProviderId("pliny"),
			modelId: "custom-reasoner",
			overrides: {
				name: "Custom Reasoner",
				maxTokens: -1,
				temperature: -1,
			},
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect((config as any).maxTokensPerTurn).toBeUndefined()
		expect((config.providerConfig as any).maxOutputTokens).toBeUndefined()
		expect((config as any).temperature).toBeUndefined()
		const knownModel = (config.providerConfig as any).knownModels["custom-reasoner"]
		expect(knownModel).not.toHaveProperty("maxTokens")
		expect(knownModel).not.toHaveProperty("temperature", -1)
	})

	it("does not inject fabricated metadata for an unknown model without overrides", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "pliny",
			actModeApiModelId: "custom/no-metadata",
		} as any)
		const getModelsSpy = vi.spyOn(LlmsModels, "getModelsForProvider").mockResolvedValueOnce({})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.knownModels).toBeUndefined()
		expect(config.providerConfig).not.toHaveProperty("knownModels")
		getModelsSpy.mockRestore()
	})

	it("enables agentic SDK compaction when global useAutoCondense is true", async () => {
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "useAutoCondense") {
				return true
			}
			if (key === "subagentsEnabled") {
				return false
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.compaction).toEqual({
			enabled: true,
			strategy: "agentic",
		})
	})

	it("uses the configured SDK compaction strategy when auto condense is enabled", async () => {
		writeJson(process.env.CLINE_GLOBAL_SETTINGS_PATH!, { compactionStrategy: "basic" })
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "useAutoCondense") {
				return true
			}
			if (key === "subagentsEnabled") {
				return false
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.compaction).toEqual({
			enabled: true,
			strategy: "basic",
		})
	})

	it("falls back to agentic SDK compaction for an invalid stored strategy", async () => {
		writeJson(process.env.CLINE_GLOBAL_SETTINGS_PATH!, { compactionStrategy: "invalid" })
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "useAutoCondense") {
				return true
			}
			if (key === "subagentsEnabled") {
				return false
			}
			return undefined
		})

		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.compaction).toEqual({
			enabled: true,
			strategy: "agentic",
		})
	})

	it("does not enable SDK compaction when global useAutoCondense is false", async () => {
		const config = await buildSessionConfig({ cwd: "/tmp/workspace" })

		expect(config.compaction).toBeUndefined()
	})

	it("enables spawn_agent unless the subagentsEnabled setting is explicitly off", async () => {
		// The shared beforeEach stores an explicit `false`.
		expect((await buildSessionConfig({ cwd: "/tmp/workspace" })).enableSpawnAgent).toBe(false)

		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "subagentsEnabled") {
				return true
			}
			return undefined
		})
		const enabled = await buildSessionConfig({ cwd: "/tmp/workspace" })
		expect(enabled.enableSpawnAgent).toBe(true)
		expect(enabled.enableAgentTeams).toBe(false)

		mocks.stateManager.getGlobalSettingsKey.mockImplementation(() => undefined)
		expect((await buildSessionConfig({ cwd: "/tmp/workspace" })).enableSpawnAgent).toBe(true)
	})

	it("lets task useAutoCondense override the global setting", async () => {
		let globalUseAutoCondense = true
		mocks.stateManager.getGlobalSettingsKey.mockImplementation((key: string) => {
			if (key === "useAutoCondense") {
				return globalUseAutoCondense
			}
			if (key === "subagentsEnabled") {
				return false
			}
			return undefined
		})

		// Task `false` overrides global `true`.
		const disabledConfig = await buildSessionConfig({
			cwd: "/tmp/workspace",
			taskSettings: { useAutoCondense: false },
		})

		// Task `true` overrides global `false`.
		globalUseAutoCondense = false
		const enabledConfig = await buildSessionConfig({
			cwd: "/tmp/workspace",
			taskSettings: { useAutoCondense: true },
		})

		expect(disabledConfig.compaction).toBeUndefined()
		expect(enabledConfig.compaction).toEqual({
			enabled: true,
			strategy: "agentic",
		})
	})

	it("emits the shared mode-tag instructions in both act and plan system prompts", async () => {
		mocks.stateManager.getApiConfiguration.mockReturnValue({} as any)

		const actConfig = await buildSessionConfig({ cwd: "/tmp/workspace", mode: "act" })
		const planConfig = await buildSessionConfig({ cwd: "/tmp/workspace", mode: "plan" })

		// The shared prompt builder now owns the mode semantics: the
		// <user_input mode> / <mode_notice> explanation goes to both modes, the
		// plan-mode contract (read-only run_commands included) only to plan.
		expect(actConfig.systemPrompt).toContain("# Plan / Act Modes")
		expect(actConfig.systemPrompt).toContain("<mode_notice>")
		expect(actConfig.systemPrompt).not.toContain("# Plan Mode\n")

		expect(planConfig.systemPrompt).toContain("# Plan / Act Modes")
		expect(planConfig.systemPrompt).toContain("# Plan Mode\n")
		expect(planConfig.systemPrompt).toContain(
			"run_commands tool remains available in plan mode strictly for read-only inspection",
		)
		// Unlike the CLI, the extension never exposes switch_to_act_mode: the
		// plan contract must direct the model to the manual Plan/Act toggle
		// instead of a tool it does not have.
		expect(planConfig.systemPrompt).not.toContain("switch_to_act_mode")
		expect(planConfig.systemPrompt).toContain("Plan/Act toggle")
	})
})

// ---------------------------------------------------------------------------
// createHistoryItemFromSession
// ---------------------------------------------------------------------------

describe("createHistoryItemFromSession", () => {
	it("creates a HistoryItem from session data", () => {
		const item = createHistoryItemFromSession(
			"session-abc",
			"Fix the bug in main.ts",
			"claude-sonnet-4-6",
			"/home/user/project",
		)

		expect(item.id).toBe("session-abc")
		expect(item.task).toBe("Fix the bug in main.ts")
		expect(item.modelId).toBe("claude-sonnet-4-6")
		expect(item.cwdOnTaskInitialization).toBe("/home/user/project")
		expect(item.workspaceRootOnTaskInitialization).toBe("/home/user/project")
		expect(item.tokensIn).toBe(0)
		expect(item.tokensOut).toBe(0)
		expect(item.totalCost).toBe(0)
		expect(item.ts).toBeGreaterThan(0)
	})

	it("handles missing optional fields", () => {
		const item = createHistoryItemFromSession("session-xyz", "Simple task")

		expect(item.modelId).toBeUndefined()
		expect(item.cwdOnTaskInitialization).toBeUndefined()
		expect(item.workspaceRootOnTaskInitialization).toBeUndefined()
	})

	it("stores workspace root separately from task cwd when provided", () => {
		const item = createHistoryItemFromSession("session-abc", "Fix build", "claude-test", "/repo/apps/web", "/repo")
		expect(item.cwdOnTaskInitialization).toBe("/repo/apps/web")
		expect(item.workspaceRootOnTaskInitialization).toBe("/repo")
	})

	it("creates unique timestamps for different calls", () => {
		const item1 = createHistoryItemFromSession("s1", "Task 1")
		const item2 = createHistoryItemFromSession("s2", "Task 2")

		// Timestamps should be at least as large (may be same if called in same ms)
		expect(item2.ts).toBeGreaterThanOrEqual(item1.ts)
	})
})

// ---------------------------------------------------------------------------
// getHistoryItemById
// ---------------------------------------------------------------------------

describe("getHistoryItemById", () => {
	it("returns undefined when task is not found", () => {
		const result = getHistoryItemById("nonexistent", tempDir)
		expect(result).toBeUndefined()
	})

	it("finds a task by ID", () => {
		const history = [
			{ id: "task-1", ts: Date.now(), task: "First task", tokensIn: 0, tokensOut: 0, totalCost: 0 },
			{ id: "task-2", ts: Date.now(), task: "Second task", tokensIn: 0, tokensOut: 0, totalCost: 0 },
		]
		writeJson(path.join(tempDir, "state", "taskHistory.json"), history)

		const result = getHistoryItemById("task-2", tempDir)
		expect(result).toBeDefined()
		expect(result?.id).toBe("task-2")
		expect(result?.task).toBe("Second task")
	})

	it("returns undefined for empty history", () => {
		writeJson(path.join(tempDir, "state", "taskHistory.json"), [])

		const result = getHistoryItemById("task-1", tempDir)
		expect(result).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// updateHistoryItem
// ---------------------------------------------------------------------------

describe("updateHistoryItem", () => {
	it("adds a new item to history", () => {
		writeJson(path.join(tempDir, "state", "taskHistory.json"), [])

		const newItem: import("@shared/HistoryItem").HistoryItem = {
			id: "task-new",
			ts: Date.now(),
			task: "New task",
			tokensIn: 100,
			tokensOut: 50,
			totalCost: 0.01,
		}

		const result = updateHistoryItem(newItem, tempDir)
		expect(result).toHaveLength(1)
		expect(result[0].id).toBe("task-new")
	})

	it("updates an existing item in history", () => {
		const existingItem = {
			id: "task-1",
			ts: Date.now(),
			task: "Original task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		writeJson(path.join(tempDir, "state", "taskHistory.json"), [existingItem])

		const updatedItem = {
			...existingItem,
			tokensIn: 500,
			tokensOut: 250,
			totalCost: 0.05,
		}

		const result = updateHistoryItem(updatedItem, tempDir)
		expect(result).toHaveLength(1)
		expect(result[0].tokensIn).toBe(500)
		expect(result[0].totalCost).toBe(0.05)
	})

	it("prepends new items to the beginning of history", () => {
		const existingItem = {
			id: "task-old",
			ts: Date.now() - 1000,
			task: "Old task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		writeJson(path.join(tempDir, "state", "taskHistory.json"), [existingItem])

		const newItem = {
			id: "task-new",
			ts: Date.now(),
			task: "New task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}

		const result = updateHistoryItem(newItem, tempDir)
		expect(result).toHaveLength(2)
		expect(result[0].id).toBe("task-new")
		expect(result[1].id).toBe("task-old")
	})
})
