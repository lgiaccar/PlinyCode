import { Logger } from "../services/Logger"

interface ClineStorageChangeEvent {
	readonly key: string
}

// ============================================================================
// Interfaces for VSCode compatibility (removes vscode import dependency)
// ============================================================================

/**
 * Memento-compatible interface for sync key-value storage.
 * VSCode's Memento and ClineSyncStorage both satisfy this interface.
 */
export interface ClineMemento {
	get<T>(key: string): T | undefined
	get<T>(key: string, defaultValue: T): T
	update(key: string, value: any): Thenable<void>
	keys(): readonly string[]
	/**
	 * Set multiple keys in a single operation.
	 * More efficient than calling update() for each key individually.
	 */
	setBatch(entries: Record<string, any>): Thenable<void>
}

// ============================================================================
// Sync Storage - for environments requiring synchronous access (e.g., CLI)
// ============================================================================

/**
 * Abstract base class for synchronous JSON storage.
 * Stores any JSON-serializable values and provides synchronous access -
 * required for VSCode Memento compatibility.
 */

type SyncStorageEventListener = (event: ClineStorageChangeEvent) => void

export abstract class ClineSyncStorage<T = any> {
	protected abstract name: string

	/**
	 * List of subscribers to storage change events.
	 */
	private readonly changeSubscribers: Array<SyncStorageEventListener> = []

	/**
	 * Subscribe to storage change events. Returns an unsubscribe function.
	 */
	public onDidChange(callback: SyncStorageEventListener): () => void {
		this.changeSubscribers.push(callback)
		return () => {
			const idx = this.changeSubscribers.indexOf(callback)
			if (idx >= 0) {
				this.changeSubscribers.splice(idx, 1)
			}
		}
	}

	/**
	 * Notify all subscribers of a key change.
	 */
	protected fireChange(key: string): void {
		for (const subscriber of this.changeSubscribers) {
			try {
				subscriber({ key })
			} catch (error) {
				Logger.error(`[${this.name}] change subscriber error for '${key}':`, error)
			}
		}
	}

	public get<V = T>(key: string): V | undefined
	public get<V = T>(key: string, defaultValue: V): V
	public get<V = T>(key: string, defaultValue?: V): V | undefined {
		try {
			const value = this._get(key) as V | undefined
			return value !== undefined ? value : defaultValue
		} catch (error) {
			Logger.error(`[${this.name}] failed to get '${key}':`, error)
			return defaultValue
		}
	}

	/**
	 * Memento-compatible update method. Calls set() internally.
	 */
	public update(key: string, value: any): Thenable<void> {
		this.set(key, value)
		return Promise.resolve()
	}

	public set(key: string, value: T | undefined): void {
		try {
			this._set(key, value)
			this.fireChange(key)
		} catch (error) {
			Logger.error(`[${this.name}] failed to set '${key}':`, error)
		}
	}

	public delete(key: string): void {
		try {
			this._delete(key)
			this.fireChange(key)
		} catch (error) {
			Logger.error(`[${this.name}] failed to delete '${key}':`, error)
		}
	}

	public keys(): readonly string[] {
		try {
			return this._keys()
		} catch (error) {
			Logger.error(`[${this.name}] failed to get keys:`, error)
			return []
		}
	}

	protected abstract _get(key: string): T | undefined
	protected abstract _set(key: string, value: T | undefined): void
	protected abstract _delete(key: string): void
	protected abstract _keys(): readonly string[]
}
