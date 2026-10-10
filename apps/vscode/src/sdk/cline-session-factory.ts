// Replaces classic task creation from src/core/task/index.ts (see origin/main)
//
// Creates and manages SDK sessions using ClineCore. This factory handles:
// - Creating ClineCore instances with proper configuration
// - Building session config from legacy state (provider, model, API key)
// - Custom session persistence adapter reading ~/.cline/data/tasks/
// - Mapping HistoryItem ↔ SDK session fields
//
// The factory does NOT handle UI concerns — that's the SdkController's job.

import {
	type ClineCoreStartInput,
	type CoreSessionConfig,
	type ProviderSettings,
	readCompactionStrategyGlobally,
	resolveProviderApiKeyFromSettings,
	type StartSessionResult,
} from "@plinycode/core"
import type { ModelInfo as SdkModelInfo } from "@plinycode/llms"
import { getGeneratedModelsForProvider, getModelsForProvider, MODEL_COLLECTIONS_BY_PROVIDER_ID } from "@plinycode/llms"
import { buildClineSystemPrompt, type GitSnapshot } from "@plinycode/shared"
import type { ApiConfiguration } from "@shared/api"
import { ClineClient } from "@shared/cline"
import type { HistoryItem } from "@shared/HistoryItem"
import { DEFAULT_LANGUAGE_SETTINGS, getLanguageKey, type LanguageDisplay } from "@shared/Languages"
import { Logger } from "@shared/services/Logger"
import type { Settings } from "@shared/storage/state-keys"
import type { Mode } from "@shared/storage/types"
import { reasoningEffortFromThinkingBudget } from "@shared/utils/reasoning-support"
import { StateManager } from "@/core/storage/StateManager"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { getDistinctId } from "@/services/logging/distinctId"
import { fetch } from "@/shared/net"
import { coerceToPlinyProvider, PLINY_PROVIDER_ID } from "@/shared/pliny"
import { buildAgentHooks } from "./hooks-adapter"
import { getHostIdeName } from "./instruction-sources"
import { resolveDataDir } from "./legacy-state-reader"
import { renderSubAgentMemoryExcerpt } from "./memory/memory-section"
import type { ResolvedModelSelection } from "./model-catalog/contracts"
import { nonNegativeFiniteNumber, positiveFiniteNumber, toSdkApiFormat } from "./model-catalog/model-values"
import { parseProviderId } from "./model-catalog/provider-id"
import { toSdkProviderId } from "./model-catalog/sdk-provider-id"
import { createProviderConfigStore, resolveRuntimeModelSelection } from "./model-catalog/store"
import { getProviderSettingsManager } from "./provider-migration"
import type { SdkSessionHost } from "./session-host"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for creating a new session */
export interface SessionConfigInput {
	/** The user's prompt */
	prompt?: string
	/** Images attached to the message */
	images?: string[]
	/** Files attached to the message */
	files?: string[]
	/** History item to resume (for task resumption) */
	historyItem?: HistoryItem
	/** Task-specific settings overrides */
	taskSettings?: Partial<Settings>
	/** Working directory */
	cwd: string
	/** Workspace root */
	workspaceRoot?: string
	/** Current mode (act/plan) */
	mode?: Mode
	/**
	 * The conversation's git snapshot for the system prompt's <env> block. The
	 * same one on every build for a conversation; see
	 * context/conversation-git-snapshots.ts.
	 */
	gitSnapshot?: GitSnapshot
	/**
	 * The date the system prompt's <env> block shows: the one the conversation
	 * started with, on every build; see context/conversation-prompt-date.ts.
	 */
	currentDate?: string
	/**
	 * The conversation's `# Memory` section, appended to the system prompt.
	 * The same text on every build for a conversation; see
	 * memory/conversation-memory-snapshots.ts.
	 */
	memorySection?: string
}

/** Active session state tracked by the factory */
export interface ActiveSession {
	/** The session ID */
	sessionId: string
	/**
	 * The config used to start the active session. `mode` and `cwd` are the
	 * session's own: a background or CI Board task keeps them while the
	 * displayed task and the mode switch move on.
	 */
	startConfig?: Pick<CoreSessionConfig, "providerId" | "modelId"> & Partial<Pick<CoreSessionConfig, "mode" | "cwd">>
	/** The runtime host instance managing this session (VscodeSessionHost) */
	sdkHost: SdkSessionHost
	/** Unsubscribe function for session events */
	unsubscribe: () => void
	/** The start result from the session */
	startResult?: StartSessionResult
	/** Whether the session is currently running */
	isRunning: boolean
	/** When the current run started (ms since epoch); set while `isRunning`. */
	runningSince?: number
}

function createSdkLogger() {
	return {
		debug: (message: string, metadata?: Record<string, unknown>) => {
			Logger.debug(message, metadata)
		},
		log: (message: string, metadata?: Record<string, unknown>) => {
			Logger.log(message, metadata)
		},
		error: (message: string, metadata?: Record<string, unknown>) => {
			Logger.error(message, metadata)
		},
	}
}

/**
 * Host identity for the session's client context, resolved through HostProvider
 * rather than the `vscode` module directly: this file is also bundled into the
 * standalone cline-core (JetBrains), where `vscode` is a Proxy-stub module and
 * direct API reads would yield non-string values. The hostbridge returns the
 * per-host values (e.g. "Cline for JetBrains" + IDE version on JetBrains).
 */
async function resolveHostIdentity() {
	try {
		return await HostProvider.env.getHostVersion({})
	} catch (error) {
		Logger.debug("Failed to resolve host version for client identity", error)
		return undefined
	}
}

async function resolveIsMultiRootWorkspace(): Promise<boolean> {
	try {
		const { paths } = await HostProvider.workspace.getWorkspacePaths({})
		return paths.length > 1
	} catch {
		return false
	}
}

function resolveWorkspaceName(workspacePath: string): string {
	const trimmed = workspacePath.trim()
	const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/, "")
	const name = withoutTrailingSeparators.split(/[\\/]/).filter(Boolean).pop()?.trim()
	return name || "workspace"
}

type ReasoningEffort = NonNullable<CoreSessionConfig["reasoningEffort"]>
type ProviderReasoningSettings = NonNullable<ProviderSettings["reasoning"]>
type SessionReasoningConfig = Pick<CoreSessionConfig, "thinking" | "reasoningEffort">

function isReasoningEffort(value: unknown): value is ReasoningEffort {
	return value === "low" || value === "medium" || value === "high" || value === "xhigh"
}

function hasStaleDisabledReasoningFields(reasoning: ProviderReasoningSettings | undefined): boolean {
	return reasoning?.enabled === false && (reasoning.effort !== undefined || reasoning.budgetTokens !== undefined)
}

function providerSettingsProviderId(providerId: string): string {
	return toSdkProviderId(providerId)
}

/**
 * Convert SDK provider-level reasoning settings into the SDK session fields that
 * are actually forwarded as model options. Keep `thinking` and
 * `reasoningEffort` coherent: a disabled/none state must never carry an effort.
 *
 * A persisted `budgetTokens` without an effort (written by older extension
 * versions or the legacy-state migration) is honored by mapping the budget
 * onto the effort scale, so users who had extended thinking enabled keep it
 * enabled after upgrading to the effort-based control.
 */
export function normalizeProviderReasoningSettings(reasoning: ProviderReasoningSettings | undefined): SessionReasoningConfig {
	if (!reasoning) {
		return {}
	}

	if (reasoning.enabled === false || reasoning.effort === "none") {
		return { thinking: false }
	}

	const effort = isReasoningEffort(reasoning.effort)
		? reasoning.effort
		: reasoningEffortFromThinkingBudget(reasoning.budgetTokens)

	if (reasoning.enabled === true) {
		return {
			thinking: true,
			...(effort ? { reasoningEffort: effort } : {}),
		}
	}

	if (isReasoningEffort(reasoning.effort)) {
		return { reasoningEffort: reasoning.effort }
	}

	// Legacy budget with no explicit enabled/effort: treat as thinking-on.
	return effort ? { thinking: true, reasoningEffort: effort } : {}
}

function resolveProviderReasoningConfig(providerId: string): SessionReasoningConfig {
	try {
		const manager = getProviderSettingsManager(resolveDataDir())
		const settings = manager.getProviderSettings(providerSettingsProviderId(providerId))
		if (!settings) {
			return {}
		}

		if (hasStaleDisabledReasoningFields(settings.reasoning)) {
			const sanitizedSettings: ProviderSettings = {
				...settings,
				reasoning: { enabled: false },
			}
			manager.saveProviderSettings(sanitizedSettings, { setLastUsed: false })
			Logger.warn(`[SessionFactory] Cleared stale disabled reasoning fields for provider=${providerId}`)
			return normalizeProviderReasoningSettings(sanitizedSettings.reasoning)
		}

		return normalizeProviderReasoningSettings(settings.reasoning)
	} catch (error) {
		Logger.warn("[SessionFactory] Provider reasoning resolution failed:", error)
		return {}
	}
}

function toSdkModelInfo(selection: ResolvedModelSelection): SdkModelInfo {
	const modelInfo = selection.modelInfo
	// Seed from the SDK capability list preserved at the catalog boundary
	// (`adaptSdkModelInfo`), then layer user overrides and the legacy boolean
	// projections on top. The preserved list is the only source that carries
	// capabilities without a legacy boolean (e.g. `tools`), and the SDK treats
	// a populated capabilities array as authoritative — reconstructing one
	// purely from the booleans silently disables everything they don't cover.
	const preservedCapabilities = modelInfo.capabilities as NonNullable<SdkModelInfo["capabilities"]> | undefined
	const capabilities = new Set<NonNullable<SdkModelInfo["capabilities"]>[number]>([
		...(preservedCapabilities ?? []),
		...((selection.overrides?.capabilities ?? []) as NonNullable<SdkModelInfo["capabilities"]>),
	])
	const setCapability = (capability: NonNullable<SdkModelInfo["capabilities"]>[number], enabled: boolean): void => {
		if (enabled) capabilities.add(capability)
		else capabilities.delete(capability)
	}
	if (modelInfo.supportsImages !== undefined) setCapability("images", modelInfo.supportsImages)
	setCapability("prompt-cache", modelInfo.supportsPromptCache)
	if (modelInfo.supportsReasoning !== undefined) setCapability("reasoning", modelInfo.supportsReasoning)
	if (selection.overrides?.supportsAttachments !== undefined) setCapability("files", selection.overrides.supportsAttachments)
	if (preservedCapabilities === undefined || preservedCapabilities.length === 0) {
		// No authoritative SDK list survived to here (dynamic-list snapshot,
		// fallback metadata, or a custom model). The array we are rebuilding
		// from booleans must still carry a definitive tool-calling signal,
		// because a non-empty capabilities array without "tools" reads as
		// "cannot call tools" to the SDK runtime. Legacy metadata only models
		// tool support for OpenAI-compatible entries via `supportsTools`.
		//
		// An EMPTY array is the same "no signal" state as an absent one —
		// modelHasCapability treats both as unspecified — and configs carried
		// over from before the field existed (or round-tripped through a
		// boundary that defaults it to []) land exactly here. Guarding only
		// `undefined` let those custom models keep a non-empty, tool-less
		// array once any boolean projection (e.g. reasoning) populated it,
		// silently disabling tool calling at the runtime gate (#13463).
		const supportsTools = (modelInfo as { supportsTools?: boolean }).supportsTools
		setCapability("tools", supportsTools !== false)
	}

	const maxTokens = positiveFiniteNumber(modelInfo.maxTokens)
	const contextWindow = positiveFiniteNumber(modelInfo.contextWindow)
	const maxInputTokens =
		positiveFiniteNumber(selection.overrides?.maxInputTokens) ?? positiveFiniteNumber(modelInfo.maxInputTokens)
	const temperature = nonNegativeFiniteNumber(modelInfo.temperature)
	const inputPrice = nonNegativeFiniteNumber(modelInfo.inputPrice)
	const outputPrice = nonNegativeFiniteNumber(modelInfo.outputPrice)
	const cacheRead = nonNegativeFiniteNumber(modelInfo.cacheReadsPrice)
	const cacheWrite = nonNegativeFiniteNumber(modelInfo.cacheWritesPrice)
	const apiFormat = toSdkApiFormat(modelInfo.apiFormat)
	const hasPricing =
		inputPrice !== undefined || outputPrice !== undefined || cacheRead !== undefined || cacheWrite !== undefined

	return {
		id: selection.modelId,
		name: modelInfo.name ?? selection.modelId,
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
		...(capabilities.size > 0 ? { capabilities: [...capabilities] } : {}),
		...(modelInfo.operation !== undefined ? { operation: modelInfo.operation } : {}),
		...(modelInfo.operationModes !== undefined ? { operationModes: [...modelInfo.operationModes] } : {}),
		...(modelInfo.modalities !== undefined ? { modalities: modelInfo.modalities } : {}),
		...(apiFormat !== undefined ? { apiFormat } : {}),
		...(temperature !== undefined ? { temperature } : {}),
		...(hasPricing
			? {
					pricing: {
						...(inputPrice !== undefined ? { input: inputPrice } : {}),
						...(outputPrice !== undefined ? { output: outputPrice } : {}),
						...(cacheRead !== undefined ? { cacheRead } : {}),
						...(cacheWrite !== undefined ? { cacheWrite } : {}),
					},
				}
			: {}),
	}
}

function resolveCommittedRuntimeModel(
	providerId: string,
	mode: Mode,
	modelId: string | undefined,
): ResolvedModelSelection | undefined {
	if (!modelId) {
		return undefined
	}
	try {
		const parsedProviderId = parseProviderId(providerId)
		const selection = createProviderConfigStore().readSelection(parsedProviderId, mode)
		return selection?.modelId === modelId ? selection : resolveRuntimeModelSelection(parsedProviderId, modelId)
	} catch (error) {
		Logger.warn(`[SessionFactory] Failed to resolve committed model settings for provider=${providerId}:`, error)
		return undefined
	}
}

// ---------------------------------------------------------------------------
// Provider/model defaults
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER_ID = PLINY_PROVIDER_ID

export function getDefaultModelIdForProvider(providerId: string): string | undefined {
	const sdkProviderId = toSdkProviderId(providerId)
	const collection = MODEL_COLLECTIONS_BY_PROVIDER_ID[sdkProviderId]
	if (!collection) {
		return undefined
	}

	const generatedModels = getGeneratedModelsForProvider(sdkProviderId)
	const defaultModelId = collection.provider.defaultModelId?.trim()
	if (defaultModelId && (generatedModels[defaultModelId] || collection.models?.[defaultModelId])) {
		return defaultModelId
	}

	return Object.keys(generatedModels)[0] || Object.keys(collection.models ?? {})[0] || undefined
}

// ---------------------------------------------------------------------------
// Provider, model, API key and base URL resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the provider for a mode. PlinyCode only runs on Pliny: a provider id
 * stored by an older version (or by upstream Cline) reads as `pliny` instead of
 * naming a provider this build can't reach.
 */
export function resolveProviderId(mode: Mode, config: ApiConfiguration | undefined): string {
	return coerceToPlinyProvider(mode === "plan" ? config?.planModeApiProvider : config?.actModeApiProvider)
}

/**
 * Resolve the API key for a provider. The settings UI saves the Pliny key in
 * providers.json (through `writeProviderConfig`), which
 * ProviderSettingsManager reads.
 */
export function resolveApiKey(providerId: string): string | undefined {
	try {
		const manager = getProviderSettingsManager()
		return resolveProviderApiKeyFromSettings(manager, providerSettingsProviderId(providerId))?.trim() || undefined
	} catch {
		Logger.warn(`[SessionFactory] Failed to read ${providerId} API key from providers.json`)
		return undefined
	}
}

/**
 * Resolve the model ID for a mode from the ApiConfiguration.
 */
export function resolveModelId(mode: Mode, config: ApiConfiguration): string | undefined {
	const field = mode === "plan" ? "planModeApiModelId" : "actModeApiModelId"
	return config[field]?.trim() || undefined
}

/**
 * Normalize a configured base URL: blank means unset, and a bare origin
 * inherits the provider default's path.
 */
export function normalizeSdkBaseUrl(providerId: string, baseUrl: unknown): string | undefined {
	if (typeof baseUrl !== "string") {
		return undefined
	}

	const trimmed = baseUrl.trim()
	if (!trimmed) {
		return undefined
	}

	const providerDefaultBaseUrl = MODEL_COLLECTIONS_BY_PROVIDER_ID[toSdkProviderId(providerId)]?.provider.baseUrl
	if (!providerDefaultBaseUrl) {
		return trimmed
	}

	try {
		const configuredUrl = new URL(trimmed)
		const defaultUrl = new URL(providerDefaultBaseUrl)
		const configuredHasPath = configuredUrl.pathname !== "/"
		const defaultHasPath = defaultUrl.pathname !== "/"

		if (!configuredHasPath && defaultHasPath) {
			configuredUrl.pathname = defaultUrl.pathname
			return configuredUrl.toString().replace(/\/$/, "")
		}
	} catch {
		return trimmed
	}

	return trimmed
}

export function resolveBaseUrl(providerId: string): string | undefined {
	// E2E test override: when PLINY_BASE_URL is set (by the e2e harness via the
	// openVSCode fixture env), short-circuit all resolution so the Pliny provider
	// talks to the local mock server instead of the real gateway. This is the
	// most reliable injection point because it runs before the SDK gateway's own
	// base URL resolution (which may use the hardcoded PLINY_BASE_URL from the
	// provider spec).
	if (providerId === PLINY_PROVIDER_ID && process.env.PLINY_BASE_URL) {
		return process.env.PLINY_BASE_URL
	}

	// A base URL saved in providers.json. Consumers that don't re-resolve
	// settings themselves — e.g. the compaction summarizer's
	// createHandlerAsync — need it on the ProviderConfig to reach the
	// configured endpoint instead of the provider default.
	try {
		const manager = getProviderSettingsManager()
		const settingsBaseUrl = manager.getProviderSettings(providerSettingsProviderId(providerId))?.baseUrl
		return normalizeSdkBaseUrl(providerId, settingsBaseUrl)
	} catch {
		Logger.warn(`[SessionFactory] Failed to read ${providerId} base URL from providers.json`)
		return undefined
	}
}

// ---------------------------------------------------------------------------
// Session config builder
// ---------------------------------------------------------------------------

/**
 * Build a CoreSessionConfig from the current state.
 *
 * Reads provider settings from the classic StateManager's ApiConfiguration
 * (which correctly reads from globalState.json + secrets.json), then resolves
 * the provider, model, and API key for the current mode (plan/act).
 *
 * This replaces the previous two-path approach (SDK ProviderSettingsManager +
 * StateManager.buildApiHandlerSettings) which both failed silently.
 */
export async function buildSessionConfig(input: SessionConfigInput): Promise<CoreSessionConfig> {
	const cwd = input.cwd
	if (!cwd) {
		throw new Error("buildSessionConfig requires a cwd resolved by the host controller")
	}
	const workspaceRoot = input.workspaceRoot?.trim() || cwd
	const mode: Mode = input.mode ?? "act"
	const sdkLogger = createSdkLogger()
	const distinctId = getDistinctId()

	// StateManager is the source of truth for the mode's model; the API key
	// and base URL live in providers.json.
	let apiConfig: ApiConfiguration | undefined
	try {
		apiConfig = StateManager.get().getApiConfiguration()
	} catch (error) {
		Logger.warn("[SessionFactory] StateManager read failed:", error)
	}

	const providerId = resolveProviderId(mode, apiConfig)
	const apiKey = resolveApiKey(providerId) ?? ""
	const baseUrl = resolveBaseUrl(providerId)
	// Keep the default aligned with the provider catalog so the UI and session
	// factory share one source of truth for default models.
	const modelId =
		(apiConfig ? resolveModelId(mode, apiConfig) : undefined) ??
		getDefaultModelIdForProvider(providerId) ??
		getDefaultModelIdForProvider(DEFAULT_PROVIDER_ID) ??
		""
	Logger.log(`[SessionFactory] Resolved provider=${providerId}, model=${modelId}, hasApiKey=${!!apiKey}`)

	const committedRuntimeModel = resolveCommittedRuntimeModel(providerId, mode, modelId)
	const overriddenMaxTokens = committedRuntimeModel?.overrides?.maxTokens
	const maxTokensPerTurn = positiveFiniteNumber(overriddenMaxTokens)
	const temperature = nonNegativeFiniteNumber(committedRuntimeModel?.overrides?.temperature)
	const reasoningConfig = resolveProviderReasoningConfig(providerId)

	let systemPrompt = ""
	try {
		const workspaceName = resolveWorkspaceName(cwd)
		systemPrompt = buildClineSystemPrompt({
			ide: getHostIdeName(),
			workspaceRoot,
			workspaceName,
			mode,
			providerId,
			platform: process.platform,
			gitSnapshot: input.gitSnapshot,
			currentDate: input.currentDate,
			// The extension never exposes switch_to_act_mode (unlike the CLI):
			// matching the legacy extension, the user must flip the Plan/Act
			// toggle themselves, so the plan contract must not tell the model to
			// call a tool it does not have.
			planModeSwitchTool: false,
		})
		Logger.log(`[SessionFactory] Built system prompt: ${systemPrompt.length} chars`)
	} catch (error) {
		Logger.warn("[SessionFactory] Failed to build system prompt, using minimal fallback:", error)
		systemPrompt = "You are Cline, a highly skilled software engineer. Help the user with their request."
	}

	// Inject preferred language instructions when a non-default language is selected.
	// Mirrors classic src/core/task/index.ts preferredLanguage handling.
	try {
		const preferredLanguageRaw = StateManager.get().getGlobalSettingsKey("preferredLanguage")
		const preferredLanguage = getLanguageKey(preferredLanguageRaw as LanguageDisplay | undefined)
		if (preferredLanguage && preferredLanguage !== DEFAULT_LANGUAGE_SETTINGS) {
			systemPrompt = `${systemPrompt}\n\n# Preferred Language\n\nSpeak in ${preferredLanguage}.`
		}
	} catch (error) {
		Logger.warn("[SessionFactory] Failed to inject preferredLanguage instructions:", error)
	}

	if (input.memorySection) {
		systemPrompt = `${systemPrompt}${input.memorySection}`
	}
	const memoryExcerpt = renderSubAgentMemoryExcerpt(input.memorySection)

	const stateManager = StateManager.get()
	// Auto compact is on by default; keep this fallback aligned with the
	// `useAutoCondense` default in shared/storage/state-keys.ts.
	const globalUseAutoCondense = stateManager.getGlobalSettingsKey("useAutoCondense") ?? true
	const compactionStrategy = readCompactionStrategyGlobally()
	const enableCheckpoints = stateManager.getGlobalSettingsKey("enableCheckpointsSetting") ?? true
	const useAutoCondense = input.taskSettings?.useAutoCondense ?? globalUseAutoCondense

	// Core resolves providers against the SDK registry, which uses the SDK's
	// own provider id spelling (e.g. "openai-compatible" rather than the
	// extension's "openai"). Convert before handing the id to core.
	const sdkProviderId = toSdkProviderId(providerId)
	const hostIdentity = await resolveHostIdentity()
	const isMultiRoot = await resolveIsMultiRootWorkspace()
	let knownModels: Awaited<ReturnType<typeof getModelsForProvider>> | undefined
	try {
		// Constructing the settings manager loads providers.json and models.json into
		// the @plinycode/llms registry. Reading models from that registry ensures custom
		// model overrides are included in the inference provider config, not just in
		// the webview/display path.
		getProviderSettingsManager(resolveDataDir())
		knownModels = await getModelsForProvider(sdkProviderId)
		// Only inject host-resolved metadata that carries real information
		// (catalog/state base or user overrides). Pure fallback fabrications
		// must not reach the runtime; the SDK's own resolution handles those.
		const isPureFallbackModel = committedRuntimeModel?.modelInfoSource === "fallback" && !committedRuntimeModel.overrides
		if (committedRuntimeModel && !isPureFallbackModel && !knownModels?.[modelId]) {
			knownModels = {
				...(knownModels ?? {}),
				[modelId]: toSdkModelInfo(committedRuntimeModel),
			}
		}
	} catch (error) {
		Logger.warn(`[SessionFactory] Failed to resolve known models for provider=${sdkProviderId}:`, error)
	}

	// Always pass a providerConfig so the proxy/CA-aware fetch reaches the SDK
	// gateway; without it the agent loop uses bare global fetch and corporate
	// proxy/self-signed CA setups fail.
	const providerConfig = {
		providerId: sdkProviderId,
		modelId,
		...(apiKey ? { apiKey } : {}),
		...(baseUrl !== undefined ? { baseUrl } : {}),
		...(knownModels && Object.keys(knownModels).length > 0 ? { knownModels } : {}),
		// Mirror the user's Max Output Tokens for consumers that build handlers
		// straight from providerConfig — notably the compaction summarizer, which
		// otherwise falls back to a small default output cap (CLINE-2911).
		...(maxTokensPerTurn !== undefined ? { maxOutputTokens: maxTokensPerTurn } : {}),
		fetch,
	}

	const config: CoreSessionConfig = {
		providerId: sdkProviderId,
		modelId,
		apiKey,
		baseUrl,
		providerConfig,
		// Also expose the catalog at the top level: manual compaction
		// (sdk-compaction.ts) budgets against config.knownModels[modelId] and
		// otherwise falls back to a conservative 64k input budget.
		...(knownModels && Object.keys(knownModels).length > 0 ? { knownModels } : {}),
		cwd,
		workspaceRoot,
		systemPrompt,
		enableTools: true,
		checkpoint: {
			enabled: enableCheckpoints,
		},
		enableSpawnAgent: stateManager.getGlobalSettingsKey("subagentsEnabled") !== false,
		enableAgentTeams: false,
		// A sub-agent's own prompt shows where it runs, like the root's
		// (sdk/packages/core: subagent-prompts.ts), with a read-only memory excerpt.
		subAgentPrompt: {
			ide: getHostIdeName(),
			platform: process.platform,
			...(input.gitSnapshot ? { gitSnapshot: input.gitSnapshot } : {}),
			...(input.currentDate ? { currentDate: input.currentDate } : {}),
			...(memoryExcerpt ? { suffix: memoryExcerpt } : {}),
		},
		...(useAutoCondense
			? {
					compaction: {
						enabled: true,
						strategy: compactionStrategy,
					},
				}
			: {}),
		disableMcpSettingsTools: true,
		mode,
		...reasoningConfig,
		...(maxTokensPerTurn !== undefined ? { maxTokensPerTurn } : {}),
		...(temperature !== undefined ? { temperature } : {}),
		maxIterations: undefined,
		logger: sdkLogger,
		extensionContext: {
			user: distinctId ? { distinctId } : undefined,
			client: {
				name: hostIdentity?.clineType || ClineClient.VSCode,
				version: hostIdentity?.clineVersion || ExtensionRegistryInfo.version,
				platform: hostIdentity?.platform || undefined,
				platformVersion: hostIdentity?.version || undefined,
				isMultiRoot,
			},
			workspace: {
				rootPath: workspaceRoot,
				cwd,
				workspaceName: resolveWorkspaceName(workspaceRoot),
				ide: getHostIdeName(),
				platform: process.platform,
				mode,
			},
			logger: sdkLogger,
		},
		hooks: buildAgentHooks(StateManager.get()),
	}

	return config
}

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

/**
 * Build the StartSessionInput for a new task.
 *
 * IMPORTANT: We pass `interactive: true` but NO `prompt`. This allocates the
 * session in memory and returns immediately; no persisted session row or
 * artifacts are created yet. The caller then uses
 * `core.send({ sessionId, prompt })` for the first user turn, which persists
 * that same session ID before inference. This keeps initialization responsive
 * without leaving empty history entries when the user never sends a message.
 */
export function buildStartSessionInput(config: CoreSessionConfig, input: SessionConfigInput): ClineCoreStartInput {
	return {
		config,
		// Do NOT pass prompt here — start() should return immediately.
		// The prompt is sent separately via core.send() after session creation.
		prompt: undefined,
		interactive: true, // VSCode extension always uses interactive mode
		userImages: input.images,
		userFiles: input.files,
	}
}

/**
 * Build the StartSessionInput for resuming an existing task.
 *
 * When resuming, we don't pass initialMessages — the SDK's session
 * persistence handles loading the conversation history from disk.
 */
export function buildResumeSessionInput(
	sessionId: string,
	prompt: string,
	images?: string[],
	files?: string[],
): { sessionId: string; prompt: string; userImages?: string[]; userFiles?: string[] } {
	return {
		sessionId,
		prompt,
		userImages: images,
		userFiles: files,
	}
}
