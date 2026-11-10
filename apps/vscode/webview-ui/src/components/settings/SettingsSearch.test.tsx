import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { SettingsSearch } from "./SettingsSearch"

const request = vi.hoisted(() => vi.fn())
vi.mock("@/services/grpc-client", () => ({ UiServiceClient: { manageSettingsCatalog: request } }))
beforeEach(() => {
	request.mockReset()
	request.mockResolvedValue({
		value: JSON.stringify({
			workspace: true,
			folder: true,
			resourceId: "file:///repo",
			settings: [
				{
					key: "plinycode.trace.enabled",
					description: "Record conversation traces",
					value: true,
					defaultValue: false,
					type: "boolean",
					source: "Workspace",
					configuredScopes: ["workspace"],
					editable: true,
				},
				{
					key: "plinycode.chat.fontSize",
					description: "Font size",
					value: 0,
					defaultValue: 0,
					type: "number",
					source: "Default",
					configuredScopes: [],
					editable: true,
				},
			],
		}),
	})
})
it("searches descriptions and resets only the chosen scope", async () => {
	render(<SettingsSearch onNavigate={vi.fn()} onSearchingChange={vi.fn()} />)
	fireEvent.change(screen.getByRole("searchbox"), { target: { value: "conversation" } })
	expect(await screen.findByText("trace.enabled")).toBeTruthy()
	expect(screen.queryByText("chat.fontSize")).toBeNull()
	fireEvent.change(screen.getByRole("combobox", { name: "Edit scope" }), { target: { value: "workspace" } })
	fireEvent.click(screen.getByRole("button", { name: "Reset workspace" }))
	await waitFor(() =>
		expect(request).toHaveBeenCalledWith({
			value: JSON.stringify({
				op: "reset",
				key: "plinycode.trace.enabled",
				scope: "workspace",
				resourceId: "file:///repo",
			}),
		}),
	)
})
it("filters explicit overrides and routes model settings to their dedicated section", async () => {
	const navigate = vi.fn()
	render(<SettingsSearch onNavigate={navigate} onSearchingChange={vi.fn()} />)
	fireEvent.click(screen.getByRole("checkbox", { name: "Modified only" }))
	expect(await screen.findByText("trace.enabled")).toBeTruthy()
	expect(screen.queryByText("chat.fontSize")).toBeNull()
	fireEvent.click(screen.getByRole("button", { name: "Clear" }))
	fireEvent.change(screen.getByRole("searchbox"), { target: { value: "model" } })
	fireEvent.click(screen.getByRole("button", { name: "Open API configuration" }))
	expect(navigate).toHaveBeenCalledWith("api-config")
})
