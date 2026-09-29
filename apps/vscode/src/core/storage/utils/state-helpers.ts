import type { ClineFileStorage } from "@shared/storage/ClineFileStorage"
import {
	applyTransform,
	GlobalStateAndSettingKeys,
	GlobalStateAndSettings,
	getDefaultValue,
	isAsyncProperty,
	isComputedProperty,
	LocalState,
	LocalStateKeys,
	SecretKeys,
	Secrets,
} from "@shared/storage/state-keys"
import { PLINY_DEFAULT_MODEL_ID, PLINY_PROVIDER_ID } from "@/shared/pliny"
import { Logger } from "@/shared/services/Logger"
import { ClineMemento } from "@/shared/storage"
import { StateManager } from "../StateManager"

// ─── File-backed storage readers (used by StateManager) ────────────────────

/**
 * Secrets written by features PlinyCode no longer has. They are deleted from
 * the secret store on start-up so old credentials don't linger on disk.
 */
const REMOVED_SECRET_KEYS: readonly string[] = [
	// OCA (Oracle Code Assist) sign-in
	"ocaApiKey",
	"ocaRefreshToken",
	"ocaAccessToken",
	"ocaTokenSet",
	// Remote config (organization-managed LiteLLM key)
	"remoteLiteLlmApiKey",
	// Cline account sign-in
	"clineApiKey",
	"clineAccountId",
	"cline:clineAccountId",
	// OpenAI Codex (ChatGPT subscription) sign-in
	"openai-codex-oauth-credentials",
	// API keys of the providers PlinyCode no longer has (it only runs on Pliny,
	// whose key lives in providers.json)
	"apiKey",
	"openRouterApiKey",
	"awsAccessKey",
	"awsSecretKey",
	"awsSessionToken",
	"awsBedrockApiKey",
	"openAiApiKey",
	"geminiApiKey",
	"openAiNativeApiKey",
	"ollamaApiKey",
	"deepSeekApiKey",
	"requestyApiKey",
	"togetherApiKey",
	"fireworksApiKey",
	"qwenApiKey",
	"doubaoApiKey",
	"mistralApiKey",
	"liteLlmApiKey",
	"asksageApiKey",
	"xaiApiKey",
	"moonshotApiKey",
	"zaiApiKey",
	"huggingFaceApiKey",
	"nebiusApiKey",
	"sambanovaApiKey",
	"cerebrasApiKey",
	"sapAiCoreClientId",
	"sapAiCoreClientSecret",
	"groqApiKey",
	"huaweiCloudMaasApiKey",
	"basetenApiKey",
	"vercelAiGatewayApiKey",
	"difyApiKey",
	"minimaxApiKey",
	"hicapApiKey",
	"aihubmixApiKey",
	"nousResearchApiKey",
	"wandbApiKey",
]

/**
 * Delete the secrets of removed features from a ClineFileStorage instance.
 * Writes to disk only when one of them is actually present.
 */
export function purgeRemovedSecrets(store: ClineFileStorage<string>): void {
	const present = REMOVED_SECRET_KEYS.filter((key) => store.get(key) !== undefined)
	if (present.length === 0) {
		return
	}
	store.setBatch(Object.fromEntries(present.map((key) => [key, undefined])))
	Logger.info(`[StateManager] Purged ${present.length} secret(s) of removed features`)
}

/**
 * Read secrets from a ClineFileStorage instance.
 */
export function readSecretsFromStorage(store: ClineFileStorage<string>): Secrets {
	return SecretKeys.reduce((acc, key) => {
		acc[key] = store.get(key)
		return acc
	}, {} as Secrets)
}

/**
 * Read workspace state from a ClineFileStorage instance.
 */
export function readWorkspaceStateFromStorage(store: ClineFileStorage): LocalState {
	return LocalStateKeys.reduce((acc, key) => {
		acc[key] = store.get(key) || {}
		return acc
	}, {} as LocalState)
}

/**
 * Read global state from a ClineFileStorage instance.
 */
export async function readGlobalStateFromStorage(store: ClineMemento): Promise<GlobalStateAndSettings> {
	try {
		// Batch read all state values in a single optimized pass
		const stateValues = new Map<string, any>()
		for (const key of GlobalStateAndSettingKeys) {
			const value = store.get(key as string)
			stateValues.set(key, value)
		}

		const result = {} as any

		for (const key of GlobalStateAndSettingKeys) {
			const stateKey = key as keyof GlobalStateAndSettings
			let value = stateValues.get(stateKey)

			if (isAsyncProperty(stateKey)) {
				continue
			}
			if (isComputedProperty(stateKey)) {
				continue
			}
			if (value === undefined) {
				const defaultValue = getDefaultValue(stateKey)
				if (defaultValue !== undefined) {
					value = defaultValue
				}
			}
			if (value !== undefined) {
				value = applyTransform(stateKey, value)
			}
			result[stateKey] = value
		}

		await handleComputedProperties(result, stateValues)

		return result as GlobalStateAndSettings
	} catch (error) {
		Logger.error("[StateHelpers] Failed to read global state from storage:", error)
		throw error
	}
}

// ─── Legacy readers (for VSCode migration — reads from ExtensionContext) ────

/**
 * Handle properties that require computed logic
 */
async function handleComputedProperties(result: any, stateValues: Map<string, any>): Promise<void> {
	// PlinyCode: always pin both modes to the Pliny provider (ignore legacy
	// Cline/OpenRouter/Anthropic selections left in global state).
	result.planModeApiProvider = PLINY_PROVIDER_ID
	result.actModeApiProvider = PLINY_PROVIDER_ID
	result.planModeApiModelId = result.planModeApiModelId || PLINY_DEFAULT_MODEL_ID
	result.actModeApiModelId = result.actModeApiModelId || PLINY_DEFAULT_MODEL_ID

	// 2. Plan/Act separate models setting with special logic
	const planActSeparateModelsSettingRaw = stateValues.get("planActSeparateModelsSetting")
	if (planActSeparateModelsSettingRaw === true || planActSeparateModelsSettingRaw === false) {
		result.planActSeparateModelsSetting = planActSeparateModelsSettingRaw
	} else {
		// Default to false when not explicitly set
		result.planActSeparateModelsSetting = false
	}
}

export async function resetWorkspaceState() {
	const stateManager = StateManager.get()
	LocalStateKeys.map((key) => stateManager.setWorkspaceState(key, {}))
	await stateManager.reInitialize()
}

export async function resetGlobalState() {
	// TODO: Reset all workspace states?
	const stateManager = StateManager.get()
	GlobalStateAndSettingKeys.map((key) => stateManager.setGlobalState(key, undefined))
	SecretKeys.map((key) => stateManager.setSecret(key, undefined))
	await stateManager.reInitialize()
}
