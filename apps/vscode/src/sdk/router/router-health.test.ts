import { beforeEach, describe, expect, it } from "vitest"
import {
	beginTurn,
	forgetSession,
	getSessionState,
	healthSnapshot,
	isModelHealthy,
	recordFailure,
	recordSuccess,
	resetHealth,
	resetSessions,
} from "./router-health"

const MODEL = "snps-provider/kimi-k2.6"
const NOW = 1_700_000_000_000

describe("model health", () => {
	beforeEach(() => {
		resetHealth()
		resetSessions()
	})

	it("treats an unseen model as healthy", () => {
		expect(isModelHealthy(MODEL, NOW)).toBe(true)
	})

	it("does not bench a model on a single failure below the threshold", () => {
		const { benched } = recordFailure(MODEL, {
			error: "boom",
			failuresBeforeCooldown: 2,
			cooldownMs: 1_000,
			now: NOW,
		})
		expect(benched).toBe(false)
		expect(isModelHealthy(MODEL, NOW)).toBe(true)
	})

	it("benches a model once it reaches the threshold", () => {
		const options = { error: "boom", failuresBeforeCooldown: 2, cooldownMs: 1_000, now: NOW }
		recordFailure(MODEL, options)
		const { benched } = recordFailure(MODEL, options)
		expect(benched).toBe(true)
		expect(isModelHealthy(MODEL, NOW)).toBe(false)
	})

	it("releases a model once the cooldown expires", () => {
		const options = { error: "boom", failuresBeforeCooldown: 1, cooldownMs: 1_000, now: NOW }
		recordFailure(MODEL, options)
		expect(isModelHealthy(MODEL, NOW + 999)).toBe(false)
		expect(isModelHealthy(MODEL, NOW + 1_001)).toBe(true)
	})

	it("clears accumulated failures on success", () => {
		const options = { error: "boom", failuresBeforeCooldown: 2, cooldownMs: 1_000, now: NOW }
		recordFailure(MODEL, options)
		recordSuccess(MODEL)
		// The next failure starts the count again, so it must not bench.
		expect(recordFailure(MODEL, options).benched).toBe(false)
	})

	it("reports the last error in the snapshot", () => {
		recordFailure(MODEL, { error: "socket closed", failuresBeforeCooldown: 1, cooldownMs: 1_000, now: NOW })
		const snapshot = healthSnapshot(NOW)
		expect(snapshot).toHaveLength(1)
		expect(snapshot[0]).toMatchObject({ modelId: MODEL, benched: true, lastError: "socket closed" })
	})
})

describe("session state", () => {
	beforeEach(() => {
		resetHealth()
		resetSessions()
	})

	it("starts empty and accumulates calls", () => {
		const state = getSessionState("s1")
		expect(state.calls).toEqual([])
		state.calls.push({ modelId: MODEL, startedAt: NOW, routeName: "coding" })
		expect(getSessionState("s1").calls).toHaveLength(1)
	})

	it("keeps sessions independent", () => {
		getSessionState("s1").failovers = 2
		expect(getSessionState("s2").failovers).toBe(0)
	})

	it("resets the call log, failovers and sticky model at the start of a turn", () => {
		const state = getSessionState("s1")
		state.calls.push({ modelId: MODEL, startedAt: NOW, routeName: "coding" })
		state.failovers = 3
		state.stickyModelId = MODEL

		const next = beginTurn("s1", NOW + 5)
		expect(next.calls).toEqual([])
		expect(next.failovers).toBe(0)
		expect(next.stickyModelId).toBeUndefined()
		expect(next.turnStartedAt).toBe(NOW + 5)
	})

	it("keeps model health across turns", () => {
		recordFailure(MODEL, { error: "boom", failuresBeforeCooldown: 1, cooldownMs: 10_000, now: NOW })
		beginTurn("s1", NOW)
		expect(isModelHealthy(MODEL, NOW)).toBe(false)
	})

	it("forgets a session entirely", () => {
		getSessionState("s1").failovers = 4
		forgetSession("s1")
		expect(getSessionState("s1").failovers).toBe(0)
	})
})
