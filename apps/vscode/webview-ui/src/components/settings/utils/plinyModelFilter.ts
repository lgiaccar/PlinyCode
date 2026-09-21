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
 * Paid models are screened behind the "Unlock Pliny paid models" checkbox in
 * Settings → API configuration. The free models are always visible. The
 * preference is persisted in the webview's `localStorage` so it survives
 * reloads/restarts; it is a pure display policy and never affects the model
 * actually used by a running task (a previously-selected paid model keeps
 * working and is shown as the active selection even while locked).
 */

const PLINY_UNLOCK_PAID_STORAGE_KEY = "plinyCode.unlockPaidModels"

/**
 * Default model to surface in the picker when paid models are locked and no
 * model has been committed yet. `snps-provider/qwen3.5-397b-fp8` is the
 * self-hosted model Kilo Code ships as its default (220k context, verified
 * tool-call-capable) — a safe, cost-free starting point.
 */
export const PLINY_FREE_DEFAULT_MODEL_ID = "snps-provider/qwen3.5-397b-fp8"

/** True for free self-hosted Pliny models (ids starting with `snps-provider`). */
export function isPlinySelfHostedModelId(modelId: string): boolean {
	return modelId.startsWith("snps-provider")
}

/** True for paid/hosted Pliny models (everything that is not self-hosted). */
export function isPlinyPaidModel(modelId: string): boolean {
	return !isPlinySelfHostedModelId(modelId)
}

// --- persisted toggle store (module-level pub/sub) ------------------------

function readStoredUnlock(): boolean {
	try {
		return globalThis.localStorage?.getItem(PLINY_UNLOCK_PAID_STORAGE_KEY) === "true"
	} catch {
		return false
	}
}

function writeStoredUnlock(value: boolean): void {
	try {
		globalThis.localStorage?.setItem(PLINY_UNLOCK_PAID_STORAGE_KEY, value ? "true" : "false")
	} catch {
		// localStorage can be unavailable (e.g. private mode); keep the value
		// in memory only.
	}
}

let currentUnlockPaid = readStoredUnlock()
const listeners = new Set<() => void>()

function notifyUnlockPaidListeners(): void {
	for (const listener of listeners) {
		listener()
	}
}

/** Read the current "unlock paid models" preference. */
export function getPlinyUnlockPaidModels(): boolean {
	return currentUnlockPaid
}

/** Update the "unlock paid models" preference and notify subscribers. */
export function setPlinyUnlockPaidModels(value: boolean): void {
	if (value === currentUnlockPaid) {
		return
	}
	currentUnlockPaid = value
	writeStoredUnlock(value)
	notifyUnlockPaidListeners()
}

/** Subscribe to preference changes; returns an unsubscribe function. */
export function subscribePlinyUnlockPaidModels(listener: () => void): () => void {
	listeners.add(listener)
	const onStorage = (event: StorageEvent) => {
		if (event.key === PLINY_UNLOCK_PAID_STORAGE_KEY) {
			currentUnlockPaid = readStoredUnlock()
			notifyUnlockPaidListeners()
		}
	}
	globalThis.addEventListener?.("storage", onStorage)
	return () => {
		listeners.delete(listener)
		globalThis.removeEventListener?.("storage", onStorage)
	}
}

/**
 * Reactive hook over the "unlock paid models" preference.
 * Returns `[unlockPaid, setUnlockPaid]`.
 */
export function usePlinyUnlockPaidModels(): [boolean, (value: boolean) => void] {
	const [value, setValue] = useState<boolean>(getPlinyUnlockPaidModels)

	useEffect(() => {
		const unsubscribe = subscribePlinyUnlockPaidModels(() => setValue(getPlinyUnlockPaidModels()))
		// Resync in case the value changed between the initial useState read
		// and the subscription being established.
		setValue(getPlinyUnlockPaidModels())
		return unsubscribe
	}, [])

	return [value, setPlinyUnlockPaidModels]
}

// --- model filtering -----------------------------------------------------

export interface FilteredPlinyModels {
	models: Record<string, ModelInfo>
	defaultModelId: string
}

/**
 * Filter a Pliny provider model map for display in the picker.
 *
 * When `unlockPaid` is true the full catalog is returned unchanged. When
 * false, only self-hosted (free) models are kept, and the default model id
 * is redirected to a free model when the catalog default is a paid one (so a
 * fresh user without a committed selection lands on a free model rather than
 * a paid one that is hidden from the list).
 *
 * A committed paid selection is intentionally *not* removed — the picker
 * surfaces it via its "not in current list" affordance so the user never
 * silently loses their configured model.
 */
export function filterPlinyModels(
	models: Record<string, ModelInfo>,
	defaultModelId: string,
	unlockPaid: boolean,
): FilteredPlinyModels {
	if (unlockPaid) {
		return { models, defaultModelId }
	}

	const filtered: Record<string, ModelInfo> = {}
	for (const [id, info] of Object.entries(models)) {
		if (isPlinySelfHostedModelId(id)) {
			filtered[id] = info
		}
	}

	let nextDefault = defaultModelId
	if (!nextDefault || isPlinyPaidModel(nextDefault) || !(nextDefault in filtered)) {
		nextDefault =
			PLINY_FREE_DEFAULT_MODEL_ID in filtered
				? PLINY_FREE_DEFAULT_MODEL_ID
				: (Object.keys(filtered)[0] ?? "")
	}

	return { models: filtered, defaultModelId: nextDefault }
}
