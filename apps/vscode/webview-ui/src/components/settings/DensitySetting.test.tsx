import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { DensitySetting } from "./DensitySetting"

const request = vi.hoisted(() => vi.fn())
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ uiDensity: "comfortable" }) }))
vi.mock("@/services/grpc-client", () => ({ UiServiceClient: { manageSettingsCatalog: request } }))
beforeEach(() => request.mockReset())
it("updates the winning folder override and displays the saved effective value", async () => {
	const result = (value: string) => ({
		value: JSON.stringify({
			resourceId: "file:///repo/file.ts",
			settings: [{ key: "plinycode.ui.density", source: "Folder", value }],
		}),
	})
	request.mockResolvedValueOnce(result("comfortable")).mockResolvedValueOnce(result("compact"))
	render(<DensitySetting />)
	fireEvent.change(screen.getByRole("combobox"), { target: { value: "compact" } })
	await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
	expect(JSON.parse(request.mock.calls[1][0].value)).toEqual({
		op: "set",
		key: "plinycode.ui.density",
		scope: "folder",
		value: "compact",
		resourceId: "file:///repo/file.ts",
	})
	await waitFor(() => expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("compact"))
})
it("keeps the current value when saving fails and allows another attempt", async () => {
	request.mockRejectedValueOnce(new Error("resource changed"))
	render(<DensitySetting />)
	fireEvent.change(screen.getByRole("combobox"), { target: { value: "compact" } })
	expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved")
	expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("comfortable")
	expect(screen.getByRole("combobox")).not.toBeDisabled()
})
