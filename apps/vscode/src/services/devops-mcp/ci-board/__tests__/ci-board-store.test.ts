import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { CiBoardStore } from "../ci-board-store"
import { DEFAULT_ACTIONS } from "../types"
import { boardTarget } from "./fake-board-provider"

describe("CiBoardStore", () => {
	let dir: string
	let file: string

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-board-store-"))
		file = path.join(dir, "data", "ci-board.json")
	})

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it("keeps each workspace's board apart", async () => {
		const store = new CiBoardStore(file)
		await store.update("/repo-a", (d) => ({ ...d, targets: [boardTarget({ id: "a", actions: DEFAULT_ACTIONS })] }))
		await store.update("/repo-b", (d) => ({ ...d, targets: [boardTarget({ id: "b" })] }))
		expect((await store.load("/repo-a")).targets.map((t) => t.id)).toEqual(["a"])
		expect((await store.load("/repo-b")).targets.map((t) => t.id)).toEqual(["b"])
		expect(await store.load("/repo-c")).toEqual({ targets: [], links: {} })
	})

	it("sees another window's writes, and serialises its own", async () => {
		const one = new CiBoardStore(file)
		const two = new CiBoardStore(file)
		await one.update("/repo", (d) => ({
			...d,
			links: { k1: { conversationId: "c1", actionId: "fix", worktree: "/w", startedTs: 1 } },
		}))
		await two.update("/repo", (d) => ({
			...d,
			links: { ...d.links, k2: { conversationId: "c2", actionId: "fix", worktree: "/w", startedTs: 2 } },
		}))
		await Promise.all([
			one.update("/repo", (d) => ({ ...d, targets: [...d.targets, boardTarget({ id: "x" })] })),
			one.update("/repo", (d) => ({ ...d, targets: [...d.targets, boardTarget({ id: "y" })] })),
		])
		const data = await one.load("/repo")
		expect(Object.keys(data.links)).toEqual(["k1", "k2"])
		expect(data.targets.map((t) => t.id)).toEqual(["x", "y"])
	})

	it("matches Windows paths without regard to case", async () => {
		const store = new CiBoardStore(file)
		await store.update("D:\\dev0\\Repo", (d) => ({ ...d, targets: [boardTarget()] }))
		expect((await store.load("d:\\dev0\\repo")).targets).toHaveLength(1)
	})

	it("reads a corrupt file or bad entries as empty", async () => {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, "{not json")
		expect(await new CiBoardStore(file).load("/repo")).toEqual({ targets: [], links: {} })
		fs.writeFileSync(
			file,
			JSON.stringify({ boards: { "/repo": { targets: [{ id: "x" }, boardTarget()], links: { k: 3 } } } }),
		)
		const data = await new CiBoardStore(file).load("/repo")
		expect([data.targets.length, Object.keys(data.links)]).toEqual([1, []])
	})
})
