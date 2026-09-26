import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MAX_RECENT_WORKSPACES, type WorkspaceRef } from "@shared/workspaceRef"
import { RecentWorkspacesStore } from "./recent-workspaces-store"

const ref = (p: string): WorkspaceRef => ({ path: p, kind: "folder", folders: [p] })

describe("RecentWorkspacesStore", () => {
	let dir: string
	let file: string

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "plinycode-recent-"))
		file = path.join(dir, "nested", "recent-workspaces.json")
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it("starts empty and remembers touched workspaces newest first", async () => {
		const store = new RecentWorkspacesStore(file)
		expect(await store.list()).toEqual([])

		await store.touch(ref("/a"), 1)
		await store.touch(ref("/b"), 2)
		await store.touch(ref("/a"), 3)

		expect((await store.list()).map((entry) => [entry.path, entry.lastUsedTs])).toEqual([
			["/a", 3],
			["/b", 2],
		])
		expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1 })
	})

	it("is read fresh on every call, so another window's writes are seen", async () => {
		const writer = new RecentWorkspacesStore(file)
		const reader = new RecentWorkspacesStore(file)
		expect(await reader.list()).toEqual([])
		await writer.touch({ path: "/all.code-workspace", kind: "workspaceFile", folders: ["/a", "/b"] })
		expect(await reader.list()).toEqual([
			{ path: "/all.code-workspace", kind: "workspaceFile", folders: ["/a", "/b"], lastUsedTs: expect.any(Number) },
		])
	})

	it("caps the list and serialises concurrent touches", async () => {
		const store = new RecentWorkspacesStore(file)
		await Promise.all(Array.from({ length: MAX_RECENT_WORKSPACES + 5 }, (_, index) => store.touch(ref(`/ws${index}`), index)))
		const list = await store.list()
		expect(list).toHaveLength(MAX_RECENT_WORKSPACES)
		expect(new Set(list.map((entry) => entry.path)).size).toBe(MAX_RECENT_WORKSPACES)
	})

	it("ignores a corrupt or malformed file", async () => {
		await rm(path.dirname(file), { recursive: true, force: true })
		await writeFile(path.join(dir, "corrupt.json"), "{not json")
		expect(await new RecentWorkspacesStore(path.join(dir, "corrupt.json")).list()).toEqual([])
		await writeFile(path.join(dir, "odd.json"), JSON.stringify({ workspaces: [{ kind: "folder" }, { path: "/ok" }, 3] }))
		expect(await new RecentWorkspacesStore(path.join(dir, "odd.json")).list()).toEqual([
			{ path: "/ok", kind: "folder", folders: ["/ok"] },
		])
	})
})
