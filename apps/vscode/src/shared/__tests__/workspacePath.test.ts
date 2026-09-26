import { describe, expect, it } from "vitest"
import { historyItemWorkspaceDisplayPath, workspacePathBasename, workspacePathLabel } from "../workspacePath"

describe("workspacePathBasename", () => {
	it("uses forward slashes on posix", () => {
		expect(workspacePathBasename("/home/user/my-project", "linux")).toBe("my-project")
	})

	it("splits Windows paths on backslashes", () => {
		expect(workspacePathBasename("C:\\Users\\dev\\my-project", "win32")).toBe("my-project")
	})
})

describe("workspacePathLabel", () => {
	it("includes the parent folder on posix", () => {
		expect(workspacePathLabel("/home/user/dev1/PlinyCode", "linux")).toBe("dev1/PlinyCode")
	})

	it("includes the parent folder on Windows", () => {
		expect(workspacePathLabel("C:\\Users\\dev\\dev1\\PlinyCode", "win32")).toBe("dev1/PlinyCode")
	})

	it("falls back to the basename alone when there's no parent", () => {
		expect(workspacePathLabel("/PlinyCode", "linux")).toBe("PlinyCode")
	})

	it("ignores a trailing slash", () => {
		expect(workspacePathLabel("/home/user/dev1/PlinyCode/", "linux")).toBe("dev1/PlinyCode")
	})
})

describe("historyItemWorkspaceDisplayPath", () => {
	it("prefers workspace root over task cwd", () => {
		expect(
			historyItemWorkspaceDisplayPath({
				cwdOnTaskInitialization: "/repo/apps/web",
				workspaceRootOnTaskInitialization: "/repo",
			}),
		).toBe("/repo")
	})

	it("falls back to cwd when workspace root is unset", () => {
		expect(historyItemWorkspaceDisplayPath({ cwdOnTaskInitialization: "/repo" })).toBe("/repo")
	})
})
