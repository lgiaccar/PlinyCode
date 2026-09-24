/**
 * Model health and per-session routing state.
 *
 * Two separate lifetimes, deliberately:
 *   - Health (failure counts, cooldowns) is process-wide. A model that is down
 *     is down for every session, and that knowledge should outlive any one task.
 *   - Turn state (call log, sticky choice, failover budget) is per session and
 *     resets each turn.
 *
 * This lives outside the routed `AgentModel` because the SDK builds a fresh
 * model for every run; state kept on the instance would be forgotten between
 * user messages.
 */

import type { RouterCallRecord } from "./router-types"

interface ModelHealth {
	consecutiveFailures: number
	/** Epoch ms until which the model is benched; 0 when available. */
	benchedUntil: number
	lastError?: string
}

const health = new Map<string, ModelHealth>()

function entry(modelId: string): ModelHealth {
	let record = health.get(modelId)
	if (!record) {
		record = { consecutiveFailures: 0, benchedUntil: 0 }
		health.set(modelId, record)
	}
	return record
}

/** Whether a model may be routed to right now. */
export function isModelHealthy(modelId: string, now: number = Date.now()): boolean {
	const record = health.get(modelId)
	return !record || record.benchedUntil <= now
}

/**
 * Record a failed call. The model is benched once it trips the configured
 * threshold, so a single transient blip does not remove it from the pool.
 */
export function recordFailure(
	modelId: string,
	options: { error: string; failuresBeforeCooldown: number; cooldownMs: number; now?: number },
): { benched: boolean } {
	const now = options.now ?? Date.now()
	const record = entry(modelId)
	record.consecutiveFailures += 1
	record.lastError = options.error
	if (record.consecutiveFailures >= options.failuresBeforeCooldown) {
		record.benchedUntil = now + options.cooldownMs
		return { benched: true }
	}
	return { benched: false }
}

/** Record a call that produced output; clears any accumulated failures. */
export function recordSuccess(modelId: string): void {
	health.delete(modelId)
}

/** Reset all health. Tests and an explicit "forget failures" action use this. */
export function resetHealth(): void {
	health.clear()
}

/** Snapshot for diagnostics. */
export function healthSnapshot(now: number = Date.now()): Array<{
	modelId: string
	benched: boolean
	consecutiveFailures: number
	lastError?: string
}> {
	return [...health.entries()].map(([modelId, record]) => ({
		modelId,
		benched: record.benchedUntil > now,
		consecutiveFailures: record.consecutiveFailures,
		...(record.lastError ? { lastError: record.lastError } : {}),
	}))
}

// ---------------------------------------------------------------------------
// Per-session turn state
// ---------------------------------------------------------------------------

export interface RouterSessionState {
	/** Calls made during the current turn, for the end-of-turn summary. */
	calls: RouterCallRecord[]
	/** Model the turn settled on, when sticky routing is enabled. */
	stickyModelId?: string
	/** Failovers already spent this turn. */
	failovers: number
	/** Epoch ms the current turn started, for the elapsed time in the summary. */
	turnStartedAt: number
}

const sessions = new Map<string, RouterSessionState>()

export function getSessionState(sessionId: string): RouterSessionState {
	let state = sessions.get(sessionId)
	if (!state) {
		state = { calls: [], failovers: 0, turnStartedAt: Date.now() }
		sessions.set(sessionId, state)
	}
	return state
}

/** Start a new turn: clear the call log and failover budget, keep health. */
export function beginTurn(sessionId: string, now: number = Date.now()): RouterSessionState {
	const state = getSessionState(sessionId)
	state.calls = []
	state.failovers = 0
	state.stickyModelId = undefined
	state.turnStartedAt = now
	return state
}

/** Drop a session's state entirely (session ended or was replaced). */
export function forgetSession(sessionId: string): void {
	sessions.delete(sessionId)
}

/** Drop every session whose id starts with `prefix` (a root turn's sub-agent runs). */
export function forgetSessionsWithPrefix(prefix: string): void {
	for (const key of [...sessions.keys()]) {
		if (key.startsWith(prefix)) {
			sessions.delete(key)
		}
	}
}

/** Reset all session state. Tests use this. */
export function resetSessions(): void {
	sessions.clear()
}
