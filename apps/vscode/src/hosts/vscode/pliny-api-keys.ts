import { randomUUID } from "node:crypto"
import type * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"

const INDEX_KEY = "plinycode.plinyApiKeys"
const SECRET_KEY = (id: string) => `plinycode.plinyApiKey:${id}`

/** A stored key as the Settings list shows it: never the key itself. */
export interface PlinyApiKeyEntry {
	id: string
	/** The name the user gave it. */
	name: string
	/** The key's last four characters, to tell keys apart. */
	last4: string
	/** Epoch milliseconds. */
	createdAt: number
}

/** The list and the active id are one value, so a write can never leave them disagreeing. */
interface KeyIndex {
	activeId?: string
	keys: PlinyApiKeyEntry[]
}

function parseIndex(raw: string | undefined): KeyIndex {
	try {
		const parsed = JSON.parse(raw ?? "{}") as { activeId?: unknown; keys?: unknown }
		const keys = Array.isArray(parsed.keys)
			? parsed.keys.filter(
					(entry): entry is PlinyApiKeyEntry =>
						typeof entry?.id === "string" &&
						typeof entry.name === "string" &&
						typeof entry.last4 === "string" &&
						typeof entry.createdAt === "number",
				)
			: []
		const activeId =
			typeof parsed.activeId === "string" && keys.some((k) => k.id === parsed.activeId) ? parsed.activeId : undefined
		return { activeId: activeId ?? keys[0]?.id, keys }
	} catch {
		return { keys: [] }
	}
}

function nextKeyAfter(
	keys: readonly PlinyApiKeyEntry[],
	id: string,
	exclude: ReadonlySet<string> = new Set(),
): PlinyApiKeyEntry | undefined {
	const start = keys.findIndex((k) => k.id === id)
	for (let step = 1; step <= keys.length; step++) {
		const candidate = keys[(start + step + keys.length) % keys.length]
		if (candidate && candidate.id !== id && !exclude.has(candidate.id)) {
			return candidate
		}
	}
	return undefined
}

/**
 * Pliny API keys the user added in Settings, each with a name, and which one
 * is in use.
 *
 * They live in the editor's SecretStorage (the OS keychain, encrypted at
 * rest) rather than in providers.json: they are credentials, and every window
 * must see a change as soon as one window makes it, which SecretStorage's
 * change event gives. The active key is kept in memory so the code that
 * builds provider configs can read it synchronously
 * (sdk/pliny-api-key-source.ts).
 */
export class PlinyApiKeys implements vscode.Disposable {
	private index: KeyIndex = { keys: [] }
	private active: string | undefined
	private readonly listeners = new Set<() => void>()
	private readonly subscription: vscode.Disposable
	/** Writes, one at a time: each reads the index the previous one wrote. */
	private queue: Promise<unknown> = Promise.resolve()
	readonly ready: Promise<void>

	constructor(private readonly secrets: vscode.SecretStorage) {
		this.subscription = secrets.onDidChange((event) => {
			// Another window changed the keys (this window's own writes reload too, harmlessly).
			if (event.key === INDEX_KEY || event.key.startsWith(SECRET_KEY(""))) {
				void this.reload()
			}
		})
		this.ready = this.reload()
	}

	/** Called after the keys or the active key changed, here or in another window. */
	onDidChange(listener: () => void): vscode.Disposable {
		this.listeners.add(listener)
		return { dispose: () => this.listeners.delete(listener) }
	}

	/** The active key, or undefined when none is stored. */
	activeKey(): string | undefined {
		return this.active
	}

	activeId(): string | undefined {
		return this.index.activeId
	}

	list(): PlinyApiKeyEntry[] {
		return this.index.keys.map((entry) => ({ ...entry }))
	}

	/** The first key after `id` in the list, wrapping round, that is not `id` and not in `exclude`. */
	nextAfter(id: string, exclude: ReadonlySet<string> = new Set()): PlinyApiKeyEntry | undefined {
		const next = nextKeyAfter(this.index.keys, id, exclude)
		return next ? { ...next } : undefined
	}

	/** The stored key with this id, for the Settings test; undefined when there is none. */
	async getKey(id: string): Promise<string | undefined> {
		if (!this.index.keys.some((k) => k.id === id)) {
			return undefined
		}
		return (await this.secrets.get(SECRET_KEY(id)))?.trim() || undefined
	}

	/** The stored entry whose key is `key`, if any. */
	async findByValue(key: string): Promise<PlinyApiKeyEntry | undefined> {
		for (const entry of this.index.keys) {
			if ((await this.secrets.get(SECRET_KEY(entry.id))) === key) {
				return { ...entry }
			}
		}
		return undefined
	}

	/** Stores a key; the first one stored becomes the active one. */
	add(name: string, key: string): Promise<PlinyApiKeyEntry> {
		return this.mutate(async (index) => {
			const entry: PlinyApiKeyEntry = { id: randomUUID(), name: name.trim(), last4: key.slice(-4), createdAt: Date.now() }
			await this.secrets.store(SECRET_KEY(entry.id), key)
			return { index: { activeId: index.activeId ?? entry.id, keys: [...index.keys, entry] }, result: entry }
		})
	}

	rename(id: string, name: string): Promise<void> {
		return this.mutate(async (index) => ({
			index: { ...index, keys: index.keys.map((k) => (k.id === id ? { ...k, name: name.trim() } : k)) },
			result: undefined,
		}))
	}

	/** Forgets a key; removing the active one makes the next one active. */
	remove(id: string): Promise<void> {
		return this.mutate(async (index) => {
			const next = index.activeId === id ? nextKeyAfter(index.keys, id)?.id : index.activeId
			await this.secrets.delete(SECRET_KEY(id))
			return { index: { activeId: next, keys: index.keys.filter((k) => k.id !== id) }, result: undefined }
		})
	}

	setActive(id: string): Promise<void> {
		return this.mutate(async (index) => ({
			index: index.keys.some((k) => k.id === id) ? { ...index, activeId: id } : index,
			result: undefined,
		}))
	}

	dispose(): void {
		this.subscription.dispose()
		this.listeners.clear()
	}

	private mutate<T>(change: (index: KeyIndex) => Promise<{ index: KeyIndex; result: T }>): Promise<T> {
		const run = this.queue.then(async () => {
			const current = parseIndex(await this.secrets.get(INDEX_KEY))
			const { index, result } = await change(current)
			await this.secrets.store(INDEX_KEY, JSON.stringify(index))
			await this.reload()
			return result
		})
		this.queue = run.catch(() => undefined)
		return run
	}

	private async reload(): Promise<void> {
		try {
			const index = parseIndex(await this.secrets.get(INDEX_KEY))
			const active = index.activeId ? (await this.secrets.get(SECRET_KEY(index.activeId)))?.trim() || undefined : undefined
			const changed =
				active !== this.active ||
				index.activeId !== this.index.activeId ||
				JSON.stringify(index) !== JSON.stringify(this.index)
			this.index = index
			this.active = active
			if (changed) {
				for (const listener of [...this.listeners]) {
					listener()
				}
			}
		} catch (error) {
			Logger.warn(
				`[PlinyApiKeys] Could not read the stored Pliny API keys: ${error instanceof Error ? error.message : error}`,
			)
		}
	}
}

let instance: PlinyApiKeys | undefined

/** The window's key store, once activation created it. */
export function getPlinyApiKeys(): PlinyApiKeys | undefined {
	return instance
}

export function setPlinyApiKeys(keys: PlinyApiKeys | undefined): void {
	instance = keys
}
