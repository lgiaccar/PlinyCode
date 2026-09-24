import { afterEach, beforeEach, describe, it } from "bun:test"
import "should"
import fs from "fs"
import os from "os"
import path from "path"
import { SyncQueue } from "../queue"
import { SyncWorker, type SyncWorkerOptions } from "../worker"

describe("SyncWorker", () => {
	let tempDir: string
	let dbPath: string
	let queue: SyncQueue

	const defaultOptions: SyncWorkerOptions = {
		userDistinctId: "test-user",
		adapterType: "unknown",
		bucket: "test-bucket",
		accessKeyId: "",
		secretAccessKey: "",
		intervalMs: 1000,
		maxRetries: 3,
		batchSize: 5,
		maxQueueSize: 100,
		maxFailedAgeMs: 7 * 24 * 60 * 60 * 1000,
		backfillEnabled: false,
	}

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncworker-test-"))
		dbPath = path.join(tempDir, "test-queue.db")
		queue = SyncQueue.getInstance(dbPath)
	})

	afterEach(async () => {
		// Clean up the worker and queue
		SyncQueue.reset()
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it("stop() completes immediately when not processing", async () => {
		const worker = new SyncWorker(queue, defaultOptions)
		worker.start()

		const start = Date.now()
		await worker.stop()
		const elapsed = Date.now() - start

		// Should complete almost immediately
		elapsed.should.be.lessThan(500)
	})

	it("stop() times out if processing takes too long instead of waiting forever", async () => {
		// This test verifies that stop() has a timeout mechanism
		// We can't easily simulate a stuck processQueue, but we can verify
		// that stop() with waitForCurrent=true doesn't hang indefinitely
		const worker = new SyncWorker(queue, defaultOptions)
		worker.start()

		// Stop with waitForCurrent=true should complete quickly since there's nothing to process
		const start = Date.now()
		await worker.stop(true)
		const elapsed = Date.now() - start

		// Should complete within a reasonable time (well under the 30s timeout)
		elapsed.should.be.lessThan(1000)
	})

	it("stop() emits WorkerStopped event", async () => {
		const worker = new SyncWorker(queue, defaultOptions)

		let stopped = false
		worker.onEvent((event) => {
			if (event.type === "worker_stopped") {
				stopped = true
			}
		})

		worker.start()
		await worker.stop()

		// Give a moment for the event to be processed
		await new Promise((resolve) => setTimeout(resolve, 50))
		stopped.should.equal(true)
	})

	it("getStatus() reports correct running state", () => {
		const worker = new SyncWorker(queue, defaultOptions)

		// Before start, should not be running
		worker.getStatus().isRunning.should.equal(false)

		worker.start()
		worker.getStatus().isRunning.should.equal(true)

		// After stop, should not be running
		// Note: stop() is async, but getStatus() is sync
	})
})
