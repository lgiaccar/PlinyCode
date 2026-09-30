import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ClineFileStorage } from "../ClineFileStorage"

describe("ClineFileStorage shared by several windows", () => {
	let dir: string
	let file: string

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-file-storage-"))
		file = path.join(dir, "globalState.json")
	})

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	const readFile = () => JSON.parse(fs.readFileSync(file, "utf-8"))

	it("keeps a key another window saved when this one writes a different key", () => {
		const windowA = new ClineFileStorage(file)
		const windowB = new ClineFileStorage(file) // loaded before A's change

		windowA.set("favoritedModelIds", ["pliny/auto-free"])
		windowB.set("mode", "act")

		expect(readFile()).toEqual({ favoritedModelIds: ["pliny/auto-free"], mode: "act" })
		expect(new ClineFileStorage(file).get<string[]>("favoritedModelIds")).toEqual(["pliny/auto-free"])
	})

	it("does not rewrite the file when a value is unchanged", () => {
		const storage = new ClineFileStorage(file)
		// Written compact; a rewrite would pretty-print it.
		const compact = JSON.stringify({ toggles: { a: true }, other: 1 })
		fs.writeFileSync(file, compact)

		storage.set("toggles", { a: true })

		expect(fs.readFileSync(file, "utf-8")).toBe(compact)
	})

	it("reload takes in what other windows saved", () => {
		const windowA = new ClineFileStorage(file)
		const windowB = new ClineFileStorage(file)
		windowA.set("favoritedModelIds", ["m1"])

		expect(windowB.get<string[]>("favoritedModelIds")).toBeUndefined()
		windowB.reload()
		expect(windowB.get<string[]>("favoritedModelIds")).toEqual(["m1"])
	})

	it("keeps its data when the file cannot be parsed", () => {
		const storage = new ClineFileStorage(file)
		storage.set("a", 1)
		fs.writeFileSync(file, "{ not json")

		storage.set("b", 2)

		expect(readFile()).toEqual({ a: 1, b: 2 })
	})
})
