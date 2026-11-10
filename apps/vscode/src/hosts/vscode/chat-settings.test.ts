import { expect, it, vi } from "vitest"
import { getUiDensity } from "./chat-settings"

const mock = vi.hoisted(() => ({ get: vi.fn(), config: vi.fn() }))
vi.mock("vscode", () => ({
	window: { activeTextEditor: { document: { uri: "active-file" } } },
	workspace: { getConfiguration: mock.config },
}))
it("reads density at the active resource and defaults safely for invalid settings", () => {
	mock.config.mockReturnValue({ get: mock.get })
	mock.get.mockReturnValue("compact")
	expect(getUiDensity()).toBe("compact")
	expect(mock.config).toHaveBeenCalledWith("plinycode.ui", "active-file")
	mock.get.mockReturnValue("unsupported")
	expect(getUiDensity()).toBe("comfortable")
	mock.config.mockImplementation(() => {
		throw new Error("unavailable")
	})
	expect(getUiDensity()).toBe("comfortable")
})
