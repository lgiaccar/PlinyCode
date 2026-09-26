import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readCodeWorkspaceFolders, resolveWorkspaceRef, workspaceRefFromWindow } from "./workspace-identity"

describe("workspace-identity", () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "plinycode-ws-"))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it("reads folders from a .code-workspace file with comments, relative paths and file URIs", async () => {
		const file = path.join(dir, "all.code-workspace")
		await writeFile(
			file,
			`{
	// VS Code writes JSON with comments and trailing commas
	"folders": [
		{ "path": "./a" },
		{ "path": "b", "name": "B" },
		{ "uri": "file:///${path.join(dir, "c").replace(/\\/g, "/").replace(/^\//, "")}" },
		{ "uri": "vscode-remote://ssh/x" },
		"not an entry",
	],
	"settings": {},
}`,
		)
		const folders = await readCodeWorkspaceFolders(file)
		expect(folders).toEqual([path.join(dir, "a"), path.join(dir, "b"), path.join(dir, "c")])
	})

	it("identifies a multi-folder workspace by its file and a single-folder one by its folder", async () => {
		const multi = path.join(dir, "multi.code-workspace")
		await writeFile(multi, JSON.stringify({ folders: [{ path: "a" }, { path: "b" }] }))
		expect(await resolveWorkspaceRef(multi)).toEqual({
			path: multi,
			kind: "workspaceFile",
			folders: [path.join(dir, "a"), path.join(dir, "b")],
		})

		const single = path.join(dir, "single.code-workspace")
		await writeFile(single, JSON.stringify({ folders: [{ path: "a" }] }))
		expect(await resolveWorkspaceRef(single)).toEqual({
			path: path.join(dir, "a"),
			kind: "folder",
			folders: [path.join(dir, "a")],
		})
	})

	it("identifies a directory by itself and rejects other files", async () => {
		const folder = path.join(dir, "proj")
		await mkdir(folder)
		expect(await resolveWorkspaceRef(folder)).toEqual({ path: folder, kind: "folder", folders: [folder] })

		const other = path.join(dir, "notes.txt")
		await writeFile(other, "hi")
		await expect(resolveWorkspaceRef(other)).rejects.toThrow(/neither a folder/)
		await expect(resolveWorkspaceRef(path.join(dir, "missing"))).rejects.toThrow()
	})

	it("rejects a .code-workspace file that is not a JSON object", async () => {
		const file = path.join(dir, "bad.code-workspace")
		await writeFile(file, "[1, 2]")
		await expect(resolveWorkspaceRef(file)).rejects.toThrow(/not a .code-workspace/)
	})

	it("derives the window workspace from the host's folders and workspace file", () => {
		expect(workspaceRefFromWindow({ paths: [] })).toBeUndefined()
		expect(workspaceRefFromWindow({ paths: ["/repo"] })).toEqual({ path: "/repo", kind: "folder", folders: ["/repo"] })
		// A single-folder window opened from a .code-workspace file is that folder.
		expect(workspaceRefFromWindow({ paths: ["/repo"], workspaceFile: "/repo.code-workspace" })).toEqual({
			path: "/repo",
			kind: "folder",
			folders: ["/repo"],
		})
		expect(workspaceRefFromWindow({ paths: ["/a", "/b"], workspaceFile: "/all.code-workspace" })).toEqual({
			path: "/all.code-workspace",
			kind: "workspaceFile",
			folders: ["/a", "/b"],
		})
		// A multi-root window without a saved workspace file is identified by its first folder.
		expect(workspaceRefFromWindow({ paths: ["/a", "/b"] })).toEqual({ path: "/a", kind: "folder", folders: ["/a"] })
	})
})
