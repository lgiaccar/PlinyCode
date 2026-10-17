import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { CiWatchStore } from "../ci-watch-store"
import { savedRecord } from "./fakes"

describe("CiWatchStore", () => {
	let dir: string
	let file: string

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-watch-store-"))
		file = path.join(dir, "data", "ci-watches.json")
	})

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it("round-trips the records of a window workspace", async () => {
		const held = { headline: "CI failed.", prompt: "[CI WATCHER] CI failed." }
		const records = [savedRecord("c1"), { conversationId: "c2", held }]
		await new CiWatchStore(file, "/repo").save(records)
		expect(await new CiWatchStore(file, Promise.resolve("/repo")).load()).toEqual(records)
		const onDisk = JSON.parse(fs.readFileSync(file, "utf8"))
		expect(onDisk.version).toBe(1)
		expect(Object.keys(onDisk.windows)).toEqual(["/repo"])
		// No temp file is left behind.
		expect(fs.readdirSync(path.dirname(file))).toEqual(["ci-watches.json"])
	})

	it("keeps each window workspace's records apart, matching Windows paths without regard to case", async () => {
		await new CiWatchStore(file, "D:\\dev0\\Repo").save([savedRecord("a")])
		await new CiWatchStore(file, "/other").save([savedRecord("b")])
		expect((await new CiWatchStore(file, "d:\\dev0\\repo").load()).map((r) => r.conversationId)).toEqual(["a"])
		expect((await new CiWatchStore(file, "/other").load()).map((r) => r.conversationId)).toEqual(["b"])
		expect(await new CiWatchStore(file, "/third").load()).toEqual([])

		// Saving nothing removes the workspace's entry and leaves the others.
		await new CiWatchStore(file, "d:\\dev0\\repo").save([])
		expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).windows)).toEqual(["/other"])
	})

	it("reads a missing, corrupt or unknown-version file as empty", async () => {
		expect(await new CiWatchStore(file, "/repo").load()).toEqual([])
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, "{not json")
		expect(await new CiWatchStore(file, "/repo").load()).toEqual([])
		fs.writeFileSync(file, JSON.stringify({ version: 99, windows: { "/repo": [savedRecord()] } }))
		expect(await new CiWatchStore(file, "/repo").load()).toEqual([])
		// A corrupt file is replaced on the next save.
		fs.writeFileSync(file, "{not json")
		await new CiWatchStore(file, "/repo").save([savedRecord()])
		expect(await new CiWatchStore(file, "/repo").load()).toHaveLength(1)
	})

	it("drops invalid records and keeps the valid parts of the rest", async () => {
		const valid = savedRecord("ok")
		const badWatch = { ...savedRecord("bad-watch"), watch: { ...valid.watch, until: "forever" } }
		const badRemote = {
			...savedRecord("bad-remote"),
			watch: { ...valid.watch, target: { ...valid.watch?.target, remote: { kind: "gitlab" } } },
			wakeUps: undefined,
		}
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				windows: {
					"/repo": [
						valid,
						valid,
						3,
						{ watch: valid.watch },
						badWatch,
						badRemote,
						{ conversationId: "held-bad", held: { headline: 1 } },
					],
				},
			}),
		)
		const records = await new CiWatchStore(file, "/repo").load()
		expect(records.map((r) => r.conversationId)).toEqual(["ok", "bad-watch"])
		// The invalid watch is dropped; its wake-up count is kept.
		expect(records[1]).toEqual({ conversationId: "bad-watch", wakeUps: 2 })
	})

	it("serialises its own writes and sees another window's", async () => {
		const one = new CiWatchStore(file, "/a")
		const two = new CiWatchStore(file, "/b")
		await two.save([savedRecord("2")])
		await Promise.all([one.save([savedRecord("1")]), one.save([savedRecord("3")])])
		expect((await one.load()).map((r) => r.conversationId)).toEqual(["3"])
		expect((await two.load()).map((r) => r.conversationId)).toEqual(["2"])
	})
})
