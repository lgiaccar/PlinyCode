import type { ModelInfo } from "@shared/api"
import { useEffect, useState } from "react"

/**
 * Pliny model gating for the PlinyCode model picker.
 *
 * The Pliny gateway exposes two classes of models:
 *  - **Free / self-hosted**: model ids that start with `snps-provider`
 *    (covers `snps-provider`, `snps-provider-vmodels`, `snps-provider-sia`,
 *    `snps-provider-internal-tests`). No per-token cost.
 *  - **Paid / hosted**: everything else (`snps-aws-bedrock`, `aws-bedrock-vmodels`,
 *    `azure-openai`, `snps-google-gcp`, `google-vertex`).
 *
 * Both classes are screened behind their own checkbox in Settings → API
 * configuration ("Unlock Pliny paid models" / "Unlock Pliny free models"),
 * each defaulting to off. Only the virtual FreeAuto router
 * (`PLINY_FREE_AUTO_MODEL_ID`) is always visible, since it is the safe,
 * effective default and never costs anything. The preferences are persisted
 * in the webview's `localStorage` so they survive reloads/restarts; this is a
 * pure display policy and never affects the model actually used by a running
 * task (a previously-selected hidden model keeps working and is shown as the
 * active selection even while locked).
 */

const PLINY_UNLOCK_PAID_STORAGE_KEY = "plinyCode.unlockPaidModels"
const PLINY_UNLOCK_FREE_STORAGE_KEY = "plinyCode.unlockFreeModels"

/** The virtual FreeAuto router id (mirrors `@plinycode/llms`). */
export const PLINY_FREE_AUTO_MODEL_ID = "pliny/free-auto"

/**
 * Default model to surface in the picker when paid models are locked and no
 * model has been committed yet. FreeAuto routes across the free self-hosted
 * pool and fails over automatically, so it is the safest cost-free start.
 */
export const PLINY_FREE_DEFAULT_MODEL_ID = PLINY_FREE_AUTO_MODEL_ID

/** True for free self-hosted Pliny models (ids starting with `snps-provider`). */
export function isPlinySelfHostedModelId(modelId: string): boolean {
	return modelId.startsWith("snps-provider")
}

/** True for the virtual router id. */
export function isPlinyFreeAutoModelId(modelId: string): boolean {
	return modelId === PLINY_FREE_AUTO_MODEL_ID
}

/**
 * True for anything that costs nothing to run: the free self-hosted models and
 * the router, which only ever delegates to them.
 */
export function isPlinyFreeModelId(modelId: string): boolean {
	return isPlinyFreeAutoModelId(modelId) || isPlinySelfHostedModelId(modelId)
}

/** True for paid/hosted Pliny models (everything that is not free). */
export function isPlinyPaidModel(modelId: string): boolean {
	return !isPlinyFreeModelId(modelId)
}

// --- persisted toggle store (module-level pub/sub) ------------------------

function createUnlockToggleStore(storageKey: string) {
	function readStored(): boolean {
		try {
			return globalThis.localStorage?.getItem(storageKey) === "true"
		} catch {
			return false
		}
	}

	function writeStored(value: boolean): void {
		try {
			globalThis.localStorage?.setItem(storageKey, value ? "true" : "false")
		} catch {
			// localStorage can be unavailable (e.g. private mode); keep the value
			// in memory only.
		}
	}

	let current = readStored()
	const listeners = new Set<() => void>()

	function notifyListeners(): void {
		for (const listener of listeners) {
			listener()
		}
	}

	function get(): boolean {
		return current
	}

	function set(value: boolean): void {
		if (value === current) {
			return
		}
		current = value
		writeStored(value)
		notifyListeners()
	}

	function subscribe(listener: () => void): () => void {
		listeners.add(listener)
		const onStorage = (event: StorageEvent) => {
			if (event.key === storageKey) {
				current = readStored()
				notifyListeners()
			}
		}
		globalThis.addEventListener?.("storage", onStorage)
		return () => {
			listeners.delete(listener)
			globalThis.removeEventListener?.("storage", onStorage)
		}
	}

	function useToggle(): [boolean, (value: boolean) => void] {
		const [value, setValue] = useState<boolean>(get)

		useEffect(() => {
			const unsubscribe = subscribe(() => setValue(get()))
			// Resync in case the value changed between the initial useState read
			// and the subscription being established.
			setValue(get())
			return unsubscribe
		}, [])

		return [value, set]
	}

	return { get, set, subscribe, useToggle }
}

const unlockPaidStore = createUnlockToggleStore(PLINY_UNLOCK_PAID_STORAGE_KEY)
const unlockFreeStore = createUnlockToggleStore(PLINY_UNLOCK_FREE_STORAGE_KEY)

/** Read the current "unlock paid models" preference. */
export const getPlinyUnlockPaidModels = unlockPaidStore.get
/** Update the "unlock paid models" preference and notify subscribers. */
export const setPlinyUnlockPaidModels = unlockPaidStore.set
/** Subscribe to "unlock paid models" preference changes; returns an unsubscribe function. */
export const subscribePlinyUnlockPaidModels = unlockPaidStore.subscribe
/**
 * Reactive hook over the "unlock paid models" preference.
 * Returns `[unlockPaid, setUnlockPaid]`.
 */
export const usePlinyUnlockPaidModels = unlockPaidStore.useToggle

/** Read the current "unlock free models" preference. */
export const getPlinyUnlockFreeModels = unlockFreeStore.get
/** Update the "unlock free models" preference and notify subscribers. */
export const setPlinyUnlockFreeModels = unlockFreeStore.set
/** Subscribe to "unlock free models" preference changes; returns an unsubscribe function. */
export const subscribePlinyUnlockFreeModels = unlockFreeStore.subscribe
/**
 * Reactive hook over the "unlock free models" preference.
 * Returns `[unlockFree, setUnlockFree]`.
 */
export const usePlinyUnlockFreeModels = unlockFreeStore.useToggle

// --- model filtering -----------------------------------------------------

export interface FilteredPlinyModels {
	models: Record<string, ModelInfo>
	defaultModelId: string
}

/**
 * Filter a Pliny provider model map for display in the picker.
 *
 * Paid (hosted) models are kept only when `unlockPaid` is true. Free
 * self-hosted models (`snps-provider*`) are kept only when `unlockFree` is
 * true. The virtual FreeAuto router is always kept regardless of either
 * toggle, since it is free, effective, and the intended default.
 *
 * When a class is filtered out and the catalog default falls in that class
 * (or isn't in the filtered set at all), the default model id is redirected
 * to the FreeAuto router so a fresh user without a committed selection lands
 * on a visible, free model rather than one that is hidden from the list.
 *
 * A committed selection outside the visible set is intentionally *not*
 * removed from what the caller may already have selected — the picker
 * surfaces it via its "not in current list" affordance so the user never
 * silently loses their configured model.
 */
export function filterPlinyModels(
	models: Record<string, ModelInfo>,
	defaultModelId: string,
	unlockPaid: boolean,
	unlockFree: boolean,
): FilteredPlinyModels {
	if (unlockPaid && unlockFree) {
		return { models, defaultModelId }
	}

	const filtered: Record<string, ModelInfo> = {}
	for (const [id, info] of Object.entries(models)) {
		if (isPlinyFreeAutoModelId(id)) {
			filtered[id] = info
		} else if (isPlinySelfHostedModelId(id)) {
			if (unlockFree) {
				filtered[id] = info
			}
		} else if (unlockPaid) {
			filtered[id] = info
		}
	}

	let nextDefault = defaultModelId
	if (!nextDefault || !(nextDefault in filtered)) {
		nextDefault = PLINY_FREE_DEFAULT_MODEL_ID in filtered ? PLINY_FREE_DEFAULT_MODEL_ID : (Object.keys(filtered)[0] ?? "")
	}

	return { models: filtered, defaultModelId: nextDefault }
}
