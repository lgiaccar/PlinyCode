import { EmptyRequest } from "@shared/proto/cline/common"
import type { PlinyBudgetResponse } from "@shared/proto/cline/models"
import { useEffect, useSyncExternalStore } from "react"
import { ModelsServiceClient } from "@/services/grpc-client"

const REFRESH_MS = 60_000
interface BudgetState {
	budget?: PlinyBudgetResponse
	loading: boolean
	error: string
	updatedAt: number
}
const empty: BudgetState = { loading: false, error: "", updatedAt: 0 }
let state = empty
let lastAttempt = 0
let generation = 0
let inflight: Promise<void> | undefined
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

function update(next: BudgetState): void {
	state = next
	for (const listener of listeners) listener()
}

/** One shared request and timer for the home screen and conversation header. */
async function fetchBudget(force = false): Promise<void> {
	if (inflight) return inflight
	if (!force && lastAttempt && Date.now() - lastAttempt < REFRESH_MS) return
	lastAttempt = Date.now()
	const requestGeneration = generation
	update({ ...state, loading: true })
	inflight = Promise.resolve()
		.then(() => ModelsServiceClient.getPlinyBudget(EmptyRequest.create({})))
		.then((response) => {
			if (generation !== requestGeneration) return
			update(
				response.available
					? { budget: response, loading: false, error: "", updatedAt: Date.now() }
					: { ...state, loading: false, error: response.error || "The gateway did not return a budget." },
			)
		})
		.catch(() => {
			if (generation === requestGeneration)
				update({ ...state, loading: false, error: "Could not load the Pliny budget. Check your connection and retry." })
		})
		.finally(() => {
			if (generation === requestGeneration) inflight = undefined
		})
	return inflight
}

/** A key change clears the old account's balance and ignores its pending response. */
export function invalidatePlinyBudget(): void {
	generation++
	inflight = undefined
	lastAttempt = 0
	update(empty)
	if (listeners.size) void fetchBudget(true)
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener)
	timer ??= setInterval(() => void fetchBudget(), REFRESH_MS)
	return () => {
		listeners.delete(listener)
		if (!listeners.size) {
			clearInterval(timer)
			timer = undefined
		}
	}
}
const noSubscribe = () => () => {}
const getState = () => state
const getEmpty = () => empty
const retry = () => void fetchBudget(true)

/** Poll while visible, preserve last known values on failure, and expose retryable errors. */
export function usePlinyBudget(enabled: boolean, refreshKey?: unknown) {
	const snapshot = useSyncExternalStore(enabled ? subscribe : noSubscribe, enabled ? getState : getEmpty)
	// biome-ignore lint/correctness/useExhaustiveDependencies: Cost changes trigger a throttled refresh.
	useEffect(() => {
		if (enabled) void fetchBudget()
	}, [enabled, refreshKey])
	return { ...snapshot, retry }
}
