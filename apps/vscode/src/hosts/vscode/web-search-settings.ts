import { isModelToolEnabledGlobally, setModelToolEnabledGlobally } from "@plinycode/core"
import * as vscode from "vscode"
import { createSearchBackend, WEB_SEARCH_PROVIDERS, type WebSearchProviderId } from "@/sdk/web/web-search-backends"
import type { WebSearchSetup } from "@/sdk/web/web-search-tool"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"

/** VS Code settings section that holds every `plinycode.webSearch.*` setting. */
const WEB_SEARCH_SETTINGS_SECTION = "plinycode.webSearch"
const DEFAULT_PROVIDER: WebSearchProviderId = "duckduckgo-html"
const DEFAULT_MAX_RESULTS = 8

/** SecretStorage key of the API key for a provider that needs one. */
const API_KEY_SECRET = (provider: WebSearchProviderId) => `plinycode.webSearch.apiKey:${provider}`

/** Providers that take an API key, with the name the key prompt shows. */
const KEYED_PROVIDERS: ReadonlyArray<{ id: WebSearchProviderId; label: string; detail: string }> = [
	{ id: "brave", label: "Brave Search", detail: "Subscription token from api-dashboard.search.brave.com" },
	{ id: "google-cse", label: "Google Programmable Search", detail: "API key for the Custom Search JSON API" },
]

/** The editor's SecretStorage, handed over at activation. */
let secretStorage: vscode.SecretStorage | undefined

function settings(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(WEB_SEARCH_SETTINGS_SECTION)
}

function configuredProvider(): WebSearchProviderId {
	const value = settings().get<string>("provider", DEFAULT_PROVIDER)
	return (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value) ? (value as WebSearchProviderId) : DEFAULT_PROVIDER
}

/**
 * `plinycode.webSearch.enabled`: whether the model gets the extension's
 * `web_search` tool (and, for providers that search natively, their own).
 * Settings → Features → Web Search reads and writes it.
 */
export function isWebSearchEnabled(): boolean {
	try {
		return settings().get<boolean>("enabled", true) !== false
	} catch {
		// Hosts without VS Code's configuration API keep the default.
		return true
	}
}

export async function setWebSearchEnabled(enabled: boolean): Promise<void> {
	await settings().update("enabled", enabled, vscode.ConfigurationTarget.Global)
}

/**
 * The search backend for the next conversation, from the `plinycode.webSearch.*`
 * settings, or undefined when web search is off. The API key is read from
 * SecretStorage at search time, so storing one applies to running conversations.
 */
export function createVscodeWebSearchSetup(): WebSearchSetup | undefined {
	if (!isWebSearchEnabled()) {
		return undefined
	}
	const config = settings()
	const provider = configuredProvider()
	const maxResults = config.get<number>("maxResults", DEFAULT_MAX_RESULTS)
	return {
		backend: createSearchBackend({
			provider,
			fetch,
			endpoint: config.get<string>("endpoint", "") || undefined,
			googleCx: config.get<string>("googleCx", "") || undefined,
			getApiKey: async () => secretStorage?.get(API_KEY_SECRET(provider)),
		}),
		maxResults: typeof maxResults === "number" && Number.isFinite(maxResults) ? maxResults : DEFAULT_MAX_RESULTS,
	}
}

/**
 * Providers that search natively (Anthropic direct) get the engine's own
 * `web_search` model tool, which has its own on/off flag in the engine's
 * global settings file. One switch should turn both off, so that flag follows
 * `plinycode.webSearch.enabled`.
 */
function syncNativeWebSearchFlag(): void {
	try {
		const enabled = isWebSearchEnabled()
		if (isModelToolEnabledGlobally("web_search") !== enabled) {
			setModelToolEnabledGlobally("web_search", enabled)
		}
	} catch (error) {
		Logger.warn("[WebSearch] Could not update the engine's web_search flag:", error)
	}
}

/**
 * Wires web search into the editor at activation: keeps the SecretStorage for
 * createVscodeWebSearchSetup, keeps the engine's native `web_search` flag in
 * step with `plinycode.webSearch.enabled`, and registers "PlinyCode: Set Web
 * Search API Key", which stores (or, given an empty value, removes) the Brave
 * or Google API key in SecretStorage.
 */
export function registerWebSearchSettings(context: vscode.ExtensionContext, commandId: string): void {
	// SecretStorage (the OS keychain) rather than the file-backed state, like the Azure DevOps Server tokens:
	// a credential, and every window sees a stored key at once.
	const secrets = context.secrets
	secretStorage = secrets
	syncNativeWebSearchFlag()
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(`${WEB_SEARCH_SETTINGS_SECTION}.enabled`)) {
				syncNativeWebSearchFlag()
			}
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commandId, async () => {
			const current = configuredProvider()
			const items = KEYED_PROVIDERS.map((entry) => ({
				...entry,
				description: entry.id === current ? "current provider" : undefined,
			})).sort((a, b) => Number(b.id === current) - Number(a.id === current))
			const picked = await vscode.window.showQuickPick(items, { placeHolder: "Which search provider is the key for?" })
			if (!picked) {
				return
			}
			const stored = await secrets.get(API_KEY_SECRET(picked.id))
			const value = await vscode.window.showInputBox({
				title: `${picked.label} API key`,
				prompt: stored
					? "A key is stored. Enter a new one to replace it, or leave the box empty to remove it."
					: "Stored in the editor's secret storage (the OS keychain), never in settings.",
				password: true,
				ignoreFocusOut: true,
			})
			if (value === undefined) {
				return
			}
			const key = value.trim()
			if (!key) {
				if (stored) {
					await secrets.delete(API_KEY_SECRET(picked.id))
					void vscode.window.showInformationMessage(`PlinyCode removed the ${picked.label} API key.`)
				}
				return
			}
			await secrets.store(API_KEY_SECRET(picked.id), key)
			const hint =
				picked.id === current ? "" : ` Set plinycode.webSearch.provider to "${picked.id}" to search with ${picked.label}.`
			void vscode.window.showInformationMessage(`PlinyCode stored the ${picked.label} API key.${hint}`)
		}),
	)
}
