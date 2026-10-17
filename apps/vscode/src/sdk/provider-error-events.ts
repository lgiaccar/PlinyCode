import type { ProviderErrorClass } from "@plinycode/shared"

/** A model request that failed for good (not a recoverable in-run notice). */
export interface ProviderErrorInfo {
	errorClass?: ProviderErrorClass
	message: string
}

type Listener = (info: ProviderErrorInfo) => void

const listeners = new Set<Listener>()

/** Hears every failed model request, of the open task, a background task or a sub-agent. */
export function onProviderError(listener: Listener): { dispose(): void } {
	listeners.add(listener)
	return { dispose: () => listeners.delete(listener) }
}

export function notifyProviderError(info: ProviderErrorInfo): void {
	for (const listener of [...listeners]) {
		try {
			listener(info)
		} catch {
			// A listener's failure must not break event handling.
		}
	}
}
