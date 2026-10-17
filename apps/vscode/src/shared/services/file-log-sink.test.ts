import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createFileLogSink, logFilePath } from "./file-log-sink"

let dir: string

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "plinycode-log-"))
})

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true })
})

describe("createFileLogSink", () => {
	it("appends lines in order and flushes them", async () => {
		const sink = createFileLogSink({ dir })
		sink.write("one")
		sink.write("two")
		sink.write("three")
		await sink.flush()
		await expect(fs.readFile(sink.filePath, "utf8")).resolves.toBe("one\ntwo\nthree\n")
		expect(sink.filePath).toBe(path.join(dir, "plinycode.log"))
	})

	it("rotates at the threshold and keeps the configured number of files", async () => {
		const sink = createFileLogSink({ dir, maxBytes: 100, keep: 3 })
		const line = "x".repeat(39) // 40 bytes with the newline
		for (let index = 0; index < 12; index += 1) {
			sink.write(`${line}`)
			await sink.flush()
		}
		const names = (await fs.readdir(dir)).sort()
		expect(names).toEqual(["plinycode.1.log", "plinycode.2.log", "plinycode.log"])
		for (const name of names) {
			const stats = await fs.stat(path.join(dir, name))
			expect(stats.size).toBeLessThanOrEqual(100)
			expect(stats.size).toBeGreaterThan(0)
		}
	})

	it("picks up the size of an existing file", async () => {
		await fs.writeFile(path.join(dir, "plinycode.log"), "y".repeat(90))
		const sink = createFileLogSink({ dir, maxBytes: 100, keep: 2 })
		sink.write("z".repeat(20))
		await sink.flush()
		await expect(fs.readFile(path.join(dir, "plinycode.1.log"), "utf8")).resolves.toBe("y".repeat(90))
		await expect(fs.readFile(path.join(dir, "plinycode.log"), "utf8")).resolves.toBe(`${"z".repeat(20)}\n`)
	})

	it("reports an unwritable folder once and never throws", async () => {
		const blocker = path.join(dir, "not-a-folder")
		await fs.writeFile(blocker, "")
		const onError = vi.fn()
		const sink = createFileLogSink({ dir: path.join(blocker, "logs"), onError })
		sink.write("one")
		sink.write("two")
		await sink.flush()
		sink.write("three")
		await sink.flush()
		expect(onError).toHaveBeenCalledTimes(1)
		expect(onError.mock.calls[0][0]).toContain("Could not write the log file")
	})
})

describe("logFilePath", () => {
	it("lives under the data directory's logs folder", () => {
		expect(logFilePath("/data")).toBe(path.join("/data", "logs", "plinycode.log"))
	})
})
