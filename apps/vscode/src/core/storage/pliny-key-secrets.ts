import { Logger } from "@shared/services/Logger"

/**
 * Keeps the Pliny API key in VS Code's SecretStorage (`context.secrets`: the OS
 * keychain, DPAPI on Windows) instead of as plain text in providers.json.
 *
 * providers.json stays the source of truth for everything else. The secret-backed
 * ProviderSettingsManager (src/sdk/secret-backed-provider-settings-manager.ts)
 * calls {@link applyPlinyKey} on every read, to put the key back into the entry
 * the rest of the extension and the engine read, and {@link extractPlinyKey} on
 * every write, to move it out before the file is written.
 *
 * Until {@link initPlinyKeySecrets} runs, and on hosts without SecretStorage,
 * both are no-ops and the key stays in providers.json as before.
 */

const PLINY_PROVIDER_ID = "pliny"
export const PLINY_API_KEY_SECRET = "plinycode.plinyApiKey"

/** The part of `vscode.SecretStorage` used here. */
export interface SecretsBackend {
	get(key: string): PromiseLike<string | undefined>
	store(key: string, value: string): PromiseLike<void>
	delete(key: string): PromiseLike<void>
	onDidChange?: (listener: (event: { key: string }) => unknown) => unknown
}

/** The part of a stored provider-settings state this module touches. */
interface ProvidersState {
	providers: Record<string, { settings?: object } | undefined>
}

let backend: SecretsBackend | undefined
let cachedKey: string | undefined
// Set when SecretStorage refuses a write (e.g. Linux without a keyring), so the
// key goes back into providers.json rather than being lost.
let plaintextFallback = false
let onPersistFailed: (() => void) | undefined
let queue: Promise<void> = Promise.resolve()

function clean(value: unknown): string | undefined {
	return typeof value === "string" ? value.trim() || undefined : undefined
}

function entryKey(state: ProvidersState): string | undefined {
	return clean((state.providers[PLINY_PROVIDER_ID]?.settings as { apiKey?: unknown } | undefined)?.apiKey)
}

function withEntryKey<T extends ProvidersState>(state: T, apiKey: string | undefined): T {
	const entry = state.providers[PLINY_PROVIDER_ID]
	if (!entry) {
		return state
	}
	const { apiKey: _previous, ...settings } = (entry.settings ?? {}) as { apiKey?: unknown }
	return {
		...state,
		providers: {
			...state.providers,
			[PLINY_PROVIDER_ID]: { ...entry, settings: apiKey ? { ...settings, apiKey } : settings },
		},
	}
}

function isActive(): boolean {
	return backend !== undefined && !plaintextFallback
}

/** Reads the stored key and starts following changes made by other windows. */
export async function initPlinyKeySecrets(secrets: SecretsBackend): Promise<void> {
	try {
		cachedKey = clean(await secrets.get(PLINY_API_KEY_SECRET))
	} catch (error) {
		Logger.error("[PlinyKeySecrets] SecretStorage is unavailable; the Pliny API key stays in providers.json:", error)
		return
	}
	backend = secrets
	plaintextFallback = false
	secrets.onDidChange?.(async (event) => {
		if (event.key !== PLINY_API_KEY_SECRET) {
			return
		}
		try {
			cachedKey = clean(await secrets.get(PLINY_API_KEY_SECRET))
		} catch (error) {
			Logger.warn("[PlinyKeySecrets] Failed to refresh the Pliny API key:", error)
		}
	})
}

/** Called when SecretStorage fails a write, to put the key back into providers.json. */
export function setPersistFailedHandler(handler: (() => void) | undefined): void {
	onPersistFailed = handler
}

/** Puts the stored key into the Pliny entry of a state read from providers.json. */
export function applyPlinyKey<T extends ProvidersState>(state: T): T {
	if (!isActive() || !cachedKey || entryKey(state)) {
		// A key still in the file (not yet migrated, or written by an older build)
		// wins until it is moved to the secret.
		return state
	}
	return withEntryKey(state, cachedKey)
}

function persist(operation: () => PromiseLike<void>): void {
	queue = queue.then(operation).then(undefined, (error) => {
		Logger.error("[PlinyKeySecrets] Failed to write the Pliny API key to SecretStorage; keeping it in providers.json:", error)
		plaintextFallback = true
		onPersistFailed?.()
	})
}

/**
 * Moves the Pliny key out of a state about to be written to providers.json and
 * into SecretStorage. A Pliny entry without a key clears the stored secret.
 */
export function extractPlinyKey<T extends ProvidersState>(state: T): T {
	const current = backend
	if (!current || plaintextFallback || !state.providers[PLINY_PROVIDER_ID]) {
		return state
	}
	const key = entryKey(state)
	if (key !== cachedKey) {
		cachedKey = key
		persist(() => (key ? current.store(PLINY_API_KEY_SECRET, key) : current.delete(PLINY_API_KEY_SECRET)))
	}
	return withEntryKey(state, undefined)
}

/**
 * Stores the key found in a state read straight from providers.json and returns
 * the state without it, for the caller to write back. Returns `undefined` when
 * there is nothing to move or SecretStorage is unusable.
 */
export async function migratePlinyKey<T extends ProvidersState>(rawState: T): Promise<T | undefined> {
	const key = entryKey(rawState)
	if (!backend || plaintextFallback || !key) {
		return undefined
	}
	try {
		await queue
		await backend.store(PLINY_API_KEY_SECRET, key)
	} catch (error) {
		Logger.error("[PlinyKeySecrets] Failed to move the Pliny API key to SecretStorage; leaving it in providers.json:", error)
		plaintextFallback = true
		return undefined
	}
	cachedKey = key
	return withEntryKey(rawState, undefined)
}

/** Test seam: forget the backend and cached key. */
export function resetPlinyKeySecretsForTests(): void {
	backend = undefined
	cachedKey = undefined
	plaintextFallback = false
	onPersistFailed = undefined
	queue = Promise.resolve()
}

/** Test seam: wait for queued SecretStorage writes. */
export function flushPlinyKeySecretsForTests(): Promise<void> {
	return queue
}
