/**
 * The Pliny API key the user chose in Settings, for code that builds provider
 * configs synchronously (session config, model catalog, budget).
 *
 * The keys themselves live in the editor's SecretStorage, which only answers
 * asynchronously; the host keeps the active one in memory and registers
 * itself here at activation (hosts/vscode/pliny-api-keys.ts). Without a
 * stored key the callers fall back to providers.json, then to PLINY_API_KEY.
 */

interface PlinyApiKeySource {
	/** The active stored key, or undefined when none is stored or it is not loaded yet. */
	activeKey(): string | undefined
	/** Settles once the stored keys have been read. */
	readonly ready: Promise<void>
}

let source: PlinyApiKeySource | undefined

export function setPlinyApiKeySource(next: PlinyApiKeySource | undefined): void {
	source = next
}

/** The active stored key for `providerId` (Pliny only), or undefined. */
export function getActivePlinyApiKey(providerId: string): string | undefined {
	if (providerId !== "pliny") {
		return undefined
	}
	return source?.activeKey()?.trim() || undefined
}

/**
 * Waits for the stored keys to load, at most `timeoutMs`: a task restored at
 * startup must not race the keychain read and fall back to PLINY_API_KEY, and
 * a keychain that hangs (a locked Linux keyring) must not block it either.
 */
export async function waitForPlinyApiKeys(timeoutMs = 2000): Promise<void> {
	if (!source) {
		return
	}
	let timer: ReturnType<typeof setTimeout> | undefined
	await Promise.race([
		source.ready.catch(() => undefined),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs)
		}),
	])
	clearTimeout(timer)
}
