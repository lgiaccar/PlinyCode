import { describe, expect, it } from "vitest"
import { historyItemWorkspaceDisplayPath, workspacePathBasename } from "../workspacePath"

describe("workspacePathBasename", () => {
	it("uses forward slashes on posix", () => {
		expect(workspacePathBasename("/home/user/my-project", "linux")).toBe("my-project")
	})

	it("splits Windows paths on backslashes", () => {
		expect(workspacePathBasename("C:\\Users\\dev\\my-project", "win32")).toBe("my-project")
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
