import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
	applyPlinyKey,
	extractPlinyKey,
	flushPlinyKeySecretsForTests,
	initPlinyKeySecrets,
	migratePlinyKey,
	PLINY_API_KEY_SECRET,
	resetPlinyKeySecretsForTests,
	type SecretsBackend,
	setPersistFailedHandler,
} from "./pliny-key-secrets"

type State = { providers: Record<string, { settings?: { provider: string; apiKey?: string; model?: string } } | undefined> }

function stateWith(apiKey?: string): State {
	return { providers: { pliny: { settings: { provider: "pliny", model: "m", ...(apiKey ? { apiKey } : {}) } } } }
}

function fakeSecrets(initial?: string, options: { failStore?: boolean } = {}) {
	const values = new Map<string, string>(initial ? [[PLINY_API_KEY_SECRET, initial]] : [])
	const listeners: Array<(event: { key: string }) => unknown> = []
	const secrets: SecretsBackend = {
		get: async (key) => values.get(key),
		store: async (key, value) => {
			if (options.failStore) throw new Error("no keyring")
			values.set(key, value)
		},
		delete: async (key) => {
			values.delete(key)
		},
		onDidChange: (listener) => {
			listeners.push(listener)
		},
	}
	return { secrets, values, emitChange: () => Promise.all(listeners.map((l) => l({ key: PLINY_API_KEY_SECRET }))) }
}

beforeEach(() => resetPlinyKeySecretsForTests())
afterEach(() => resetPlinyKeySecretsForTests())

describe("before SecretStorage is initialised", () => {
	it("leaves the state alone", () => {
		const state = stateWith("file-key")
		expect(applyPlinyKey(state)).toBe(state)
		expect(extractPlinyKey(state)).toBe(state)
	})
})

describe("with SecretStorage", () => {
	it("puts the stored key into the Pliny entry on read", async () => {
		const { secrets } = fakeSecrets("secret-key")
		await initPlinyKeySecrets(secrets)
		expect(applyPlinyKey(stateWith()).providers.pliny?.settings?.apiKey).toBe("secret-key")
	})

	it("does not invent a Pliny entry", async () => {
		const { secrets } = fakeSecrets("secret-key")
		await initPlinyKeySecrets(secrets)
		const empty: State = { providers: {} }
		expect(applyPlinyKey(empty)).toBe(empty)
	})

	it("prefers a key still in the file until it is migrated", async () => {
		const { secrets } = fakeSecrets("secret-key")
		await initPlinyKeySecrets(secrets)
		expect(applyPlinyKey(stateWith("file-key")).providers.pliny?.settings?.apiKey).toBe("file-key")
	})

	it("moves a new key to the secret and strips it from the file", async () => {
		const { secrets, values } = fakeSecrets()
		await initPlinyKeySecrets(secrets)
		const written = extractPlinyKey(stateWith("new-key"))
		await flushPlinyKeySecretsForTests()
		expect(written.providers.pliny?.settings).toEqual({ provider: "pliny", model: "m" })
		expect(values.get(PLINY_API_KEY_SECRET)).toBe("new-key")
	})

	it("does not rewrite an unchanged secret", async () => {
		const { secrets, values } = fakeSecrets("same")
		await initPlinyKeySecrets(secrets)
		values.set(PLINY_API_KEY_SECRET, "changed-elsewhere-but-cache-not-refreshed")
		extractPlinyKey(stateWith("same"))
		await flushPlinyKeySecretsForTests()
		expect(values.get(PLINY_API_KEY_SECRET)).toBe("changed-elsewhere-but-cache-not-refreshed")
	})

	it("deletes the secret when the Pliny entry no longer has a key", async () => {
		const { secrets, values } = fakeSecrets("secret-key")
		await initPlinyKeySecrets(secrets)
		extractPlinyKey(stateWith())
		await flushPlinyKeySecretsForTests()
		expect(values.has(PLINY_API_KEY_SECRET)).toBe(false)
	})

	it("keeps the secret when the state has no Pliny entry", async () => {
		const { secrets, values } = fakeSecrets("secret-key")
		await initPlinyKeySecrets(secrets)
		extractPlinyKey({ providers: {} })
		await flushPlinyKeySecretsForTests()
		expect(values.get(PLINY_API_KEY_SECRET)).toBe("secret-key")
	})

	it("refreshes the cached key when another window changes it", async () => {
		const { secrets, values, emitChange } = fakeSecrets("old")
		await initPlinyKeySecrets(secrets)
		values.set(PLINY_API_KEY_SECRET, "rotated")
		await emitChange()
		expect(applyPlinyKey(stateWith()).providers.pliny?.settings?.apiKey).toBe("rotated")
	})

	it("falls back to the file when SecretStorage refuses a write", async () => {
		const { secrets } = fakeSecrets(undefined, { failStore: true })
		await initPlinyKeySecrets(secrets)
		let failed = 0
		setPersistFailedHandler(() => failed++)
		extractPlinyKey(stateWith("new-key"))
		await flushPlinyKeySecretsForTests()
		expect(failed).toBe(1)
		const state = stateWith("new-key")
		expect(extractPlinyKey(state)).toBe(state)
	})
})

describe("migratePlinyKey", () => {
	it("stores the file key and returns the state without it", async () => {
		const { secrets, values } = fakeSecrets()
		await initPlinyKeySecrets(secrets)
		const stripped = await migratePlinyKey(stateWith("file-key"))
		expect(values.get(PLINY_API_KEY_SECRET)).toBe("file-key")
		expect(stripped?.providers.pliny?.settings?.apiKey).toBeUndefined()
		expect(applyPlinyKey(stateWith()).providers.pliny?.settings?.apiKey).toBe("file-key")
	})

	it("does nothing when the file has no key", async () => {
		const { secrets } = fakeSecrets("secret-key")
		await initPlinyKeySecrets(secrets)
		expect(await migratePlinyKey(stateWith())).toBeUndefined()
	})

	it("leaves the key in the file when SecretStorage fails", async () => {
		const { secrets } = fakeSecrets(undefined, { failStore: true })
		await initPlinyKeySecrets(secrets)
		expect(await migratePlinyKey(stateWith("file-key"))).toBeUndefined()
	})

	it("does nothing without SecretStorage", async () => {
		expect(await migratePlinyKey(stateWith("file-key"))).toBeUndefined()
	})
})
