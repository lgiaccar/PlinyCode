import { EmptyRequest } from "@shared/proto/cline/common"
import type { PlinyBudgetResponse } from "@shared/proto/cline/models"
import { useEffect, useState } from "react"
import { ModelsServiceClient } from "@/services/grpc-client"

/** Gateway usage lags behind requests, so refetching more often than this buys nothing. */
const MIN_REFRESH_MS = 60_000

// Shared across every mounted indicator so the home screen and the task
// header don't each hit the gateway.
let cached: { budget: PlinyBudgetResponse; fetchedAt: number } | undefined
let inflight: Promise<PlinyBudgetResponse> | undefined
const invalidationListeners = new Set<() => void>()

/** Drops the cached budget and refetches it in every mounted indicator: the active key changed. */
export function invalidatePlinyBudget(): void {
	cached = undefined
	for (const listener of [...invalidationListeners]) {
		listener()
	}
}

function fetchBudget(force: boolean): Promise<PlinyBudgetResponse> {
	if (!force && cached && Date.now() - cached.fetchedAt < MIN_REFRESH_MS) {
		return Promise.resolve(cached.budget)
	}
	inflight ??= ModelsServiceClient.getPlinyBudget(EmptyRequest.create({}))
		.then((budget) => {
			cached = { budget, fetchedAt: Date.now() }
			return budget
		})
		.finally(() => {
			inflight = undefined
		})
	return inflight
}

/**
 * The caller's remaining Pliny budget, or undefined while loading, when
 * disabled, or when the gateway has none to report. Refetches (at most once
 * a minute) whenever `refreshKey` changes, e.g. as a task's cost grows.
 */
export function usePlinyBudget(enabled: boolean, refreshKey?: unknown): PlinyBudgetResponse | undefined {
	const [budget, setBudget] = useState<PlinyBudgetResponse | undefined>(() =>
		enabled && cached?.budget.available ? cached.budget : undefined,
	)
	const [generation, setGeneration] = useState(0)

	useEffect(() => {
		const listener = () => setGeneration((value) => value + 1)
		invalidationListeners.add(listener)
		return () => {
			invalidationListeners.delete(listener)
		}
	}, [])

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and generation only trigger a refetch
	useEffect(() => {
		if (!enabled) {
			setBudget(undefined)
			return
		}
		let cancelled = false
		fetchBudget(false)
			.then((result) => {
				if (!cancelled) {
					setBudget(result.available ? result : undefined)
				}
			})
			.catch((error) => console.debug("Failed to fetch Pliny budget:", error))
		return () => {
			cancelled = true
		}
	}, [enabled, refreshKey, generation])

	return budget
}
