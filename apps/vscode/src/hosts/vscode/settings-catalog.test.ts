import { beforeEach, expect, it, vi } from "vitest"
import { manageSettingsCatalog } from "./settings-catalog"

const mock = vi.hoisted(() => ({ inspect: vi.fn(), get: vi.fn(), update: vi.fn(), command: vi.fn(), folder: vi.fn() }))
vi.mock("vscode", () => ({
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	window: {},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/repo", toString: () => "file:///repo" } }],
		getWorkspaceFolder: mock.folder,
		getConfiguration: () => ({ inspect: mock.inspect, get: mock.get, update: mock.update }),
	},
	commands: { executeCommand: mock.command },
}))
beforeEach(() => {
	vi.clearAllMocks()
	mock.folder.mockReturnValue({})
	mock.inspect.mockReturnValue({ defaultValue: true, globalValue: false, workspaceValue: true })
	mock.get.mockReturnValue(true)
	mock.update.mockResolvedValue(undefined)
})
it("shows the winning scope and preserves all configured scopes", async () => {
	const catalog = await manageSettingsCatalog({})
	expect(catalog.settings.find((setting) => setting.key === "plinycode.trace.enabled")).toMatchObject({
		source: "Workspace",
		configuredScopes: ["user", "workspace"],
		value: true,
	})
})
it("resets only the selected scope, never overwriting it with the default", async () => {
	await manageSettingsCatalog({ op: "reset", key: "plinycode.trace.enabled", scope: "workspace", resourceId: "file:///repo" })
	expect(mock.update).toHaveBeenCalledWith("plinycode.trace.enabled", undefined, 2, false)
})
it("rejects other extensions, invalid values and stale resource scopes", async () => {
	await expect(manageSettingsCatalog({ op: "set", key: "editor.fontSize", value: 1, scope: "user" })).rejects.toThrow("Unknown")
	await expect(
		manageSettingsCatalog({
			op: "set",
			key: "plinycode.compaction.threshold",
			value: 3,
			scope: "user",
			resourceId: "file:///repo",
		}),
	).rejects.toThrow("range")
	await expect(
		manageSettingsCatalog({ op: "reset", key: "plinycode.trace.enabled", scope: "workspace", resourceId: "file:///old" }),
	).rejects.toThrow("changed")
	expect(mock.update).not.toHaveBeenCalled()
})
