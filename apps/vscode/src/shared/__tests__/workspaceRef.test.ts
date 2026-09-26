import { describe, expect, it } from "vitest"
import { workspacePathsEqual } from "../workspacePath"
import {
	historyItemWorkspaceRef,
	isCodeWorkspaceFilePath,
	MAX_RECENT_WORKSPACES,
	pushRecentWorkspace,
	type WorkspaceRef,
	workspaceRefLabel,
	workspaceRefsEqual,
} from "../workspaceRef"

describe("workspacePathsEqual", () => {
	it("ignores separator style, trailing slashes and drive-letter case on Windows paths", () => {
		expect(workspacePathsEqual("C:\\dev\\PlinyCode", "c:/dev/PlinyCode/")).toBe(true)
		expect(workspacePathsEqual("C:\\dev\\PlinyCode", "C:\\dev\\Other")).toBe(false)
	})

	it("compares posix paths case-sensitively", () => {
		expect(workspacePathsEqual("/home/dev/PlinyCode", "/home/dev/PlinyCode/")).toBe(true)
		expect(workspacePathsEqual("/home/dev/PlinyCode", "/home/dev/plinycode")).toBe(false)
	})

	it("treats two empty paths as equal and an empty one as different from any path", () => {
		expect(workspacePathsEqual(undefined, "")).toBe(true)
		expect(workspacePathsEqual("", "/repo")).toBe(false)
	})
})

describe("workspaceRefLabel", () => {
	it("labels a folder with its parent", () => {
		expect(workspaceRefLabel({ path: "/home/dev/dev1/PlinyCode", kind: "folder" }, "linux")).toBe("dev1/PlinyCode")
	})

	it("labels a .code-workspace file by its name without the extension", () => {
		expect(workspaceRefLabel({ path: "C:\\dev\\my-project.code-workspace", kind: "workspaceFile" }, "win32")).toBe(
			"my-project",
		)
	})
})

describe("historyItemWorkspaceRef", () => {
	it("prefers the recorded binding over the workspace root", () => {
		expect(
			historyItemWorkspaceRef({
				workspacePath: "/repo/all.code-workspace",
				workspaceKind: "workspaceFile",
				workspaceRootOnTaskInitialization: "/repo/a",
			}),
		).toEqual({ path: "/repo/all.code-workspace", kind: "workspaceFile" })
	})

	it("binds older items to the folder they ran in", () => {
		expect(historyItemWorkspaceRef({ cwdOnTaskInitialization: "/repo" })).toEqual({ path: "/repo", kind: "folder" })
		expect(historyItemWorkspaceRef({})).toBeUndefined()
	})
})

describe("pushRecentWorkspace", () => {
	const ref = (path: string): WorkspaceRef => ({ path, kind: "folder", folders: [path] })

	it("moves a re-used workspace to the front without duplicating it", () => {
		const list = pushRecentWorkspace([ref("/a"), ref("/b"), ref("/c")], ref("/b/"), 42)
		expect(list.map((entry) => entry.path)).toEqual(["/b/", "/a", "/c"])
		expect(list[0].lastUsedTs).toBe(42)
	})

	it("keeps at most the last ten", () => {
		let list: WorkspaceRef[] = []
		for (let index = 0; index < MAX_RECENT_WORKSPACES + 3; index++) {
			list = pushRecentWorkspace(list, ref(`/ws${index}`), index)
		}
		expect(list).toHaveLength(MAX_RECENT_WORKSPACES)
		expect(list[0].path).toBe(`/ws${MAX_RECENT_WORKSPACES + 2}`)
		expect(list.at(-1)?.path).toBe("/ws3")
	})
})

describe("workspaceRefsEqual / isCodeWorkspaceFilePath", () => {
	it("matches identities by path only", () => {
		expect(workspaceRefsEqual({ path: "/a" }, { path: "/a/" })).toBe(true)
		expect(workspaceRefsEqual({ path: "/a" }, undefined)).toBe(false)
	})

	it("recognises .code-workspace files case-insensitively", () => {
		expect(isCodeWorkspaceFilePath("x.CODE-WORKSPACE")).toBe(true)
		expect(isCodeWorkspaceFilePath("x.json")).toBe(false)
	})
})
