import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createStorageContext } from "@/shared/storage/storage-context"
import { StateManager } from "../StateManager"

vi.mock("@/services/logging/distinctId", () => ({
	initializeDistinctId: vi.fn(async () => undefined),
}))

describe("StateManager dispose and cleanup", () => {
	let clineDir: string
	let stateManager: StateManager

	beforeAll(async () => {
		clineDir = await fs.mkdtemp(path.join(os.tmpdir(), "statemanager-dispose-test-"))
		// Use reInitialize if already initialized (singleton state from other test suites),
		// otherwise initialize fresh.
		const storage = createStorageContext({ clineDir, workspacePath: clineDir })
		try {
			await StateManager.initialize(storage)
		} catch {
			// Already initialized - reInitialize with the new storage context
			await StateManager.get().reInitialize()
		}
		stateManager = StateManager.get()
	})

	afterAll(async () => {
		await StateManager.get().flushPendingState()
		await StateManager.get().reInitialize()
		await fs.rm(clineDir, { recursive: true, force: true })
	})

	beforeEach(async () => {
		// Reset state between tests
		await stateManager.clearTaskSettings()
	})

	it("flushPendingState clears pending state and completes without error", async () => {
		// Set some global state
		stateManager.setGlobalState("clineVersion", "0.1.1")

		// Flush should complete without error
		await stateManager.flushPendingState()

		// State should still be readable
		const result = stateManager.getGlobalStateKey("clineVersion")
		expect(result).toBe("0.1.1")
	})

	it("multiple rapid state writes are debounced correctly", async () => {
		// Write state multiple times rapidly
		for (let i = 0; i < 10; i++) {
			stateManager.setGlobalState("clineVersion", `0.1.${i}`)
		}

		// Flush should complete without error
		await stateManager.flushPendingState()

		// The last value should be persisted
		const result = stateManager.getGlobalStateKey("clineVersion")
		expect(result).toBe("0.1.9")
	})

	it("flushPendingState is safe to call when there is no pending state", async () => {
		// Clear any pending state first
		await stateManager.flushPendingState()

		// Calling flush again should be safe
		await stateManager.flushPendingState()

		// Should not throw
		expect(true).toBe(true)
	})
})
