import { DEFAULT_MEMORY_TUNING } from "@shared/memory"
import type { MemoryPanelState } from "@shared/memory-panel"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import MemorySettings from "./MemorySettings"

const mocks = vi.hoisted(() => ({ request: vi.fn(), update: vi.fn(), open: vi.fn(async () => ({})) }))
vi.mock("@/services/memory-client", () => ({ memoryRequest: mocks.request }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ memoryConversationSearchEnabled: true }) }))
vi.mock("./utils/settingsHandlers", () => ({ updateSetting: mocks.update }))
vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: { openFile: mocks.open },
	TaskServiceClient: { resolveMemoryProposal: vi.fn() },
}))

let state: MemoryPanelState
beforeEach(() => {
	mocks.request.mockReset()
	mocks.update.mockClear()
	mocks.open.mockClear()
	state = {
		entries: [
			{ id: "repo:1", scope: "repo", text: "Always target stage", importance: "high", pinned: false, type: "convention" },
		],
		pending: [],
		budget: "auto",
		distill: "offer",
		tuning: { ...DEFAULT_MEMORY_TUNING },
		adoption: [],
		usage: {},
	}
	mocks.request.mockImplementation(async (input: Record<string, unknown> = {}) => {
		if (input.action === "settings" && input.budget !== undefined) state.budget = input.budget as string
		return { ...state }
	})
})

describe("Memory settings", () => {
	it("accepts token and percentage budgets", async () => {
		render(<MemorySettings />)
		const field = await screen.findByLabelText("Memory budget (tokens or %)")
		fireEvent.change(field, { target: { value: "8000" } })
		fireEvent.blur(field)
		await waitFor(() => expect(mocks.request).toHaveBeenCalledWith({ action: "settings", budget: "8000" }))
		fireEvent.change(field, { target: { value: "4%" } })
		fireEvent.blur(field)
		await waitFor(() => expect(mocks.request).toHaveBeenCalledWith({ action: "settings", budget: "4%" }))
	})
	it("offers auto distillation and keeps its review explanation visible", async () => {
		render(<MemorySettings />)
		const field = await screen.findByLabelText("After a conversation")
		fireEvent.change(field, { target: { value: "auto" } })
		await waitFor(() => expect(mocks.request).toHaveBeenCalledWith({ action: "settings", distill: "auto" }))
		expect(screen.getByText(/Important proposals always need review/)).toBeTruthy()
	})
	it("disables automatic offers when memory is off", async () => {
		state.budget = 0
		render(<MemorySettings />)
		const field = (await screen.findByLabelText("After a conversation")) as HTMLSelectElement
		expect(field.disabled).toBe(true)
	})
	it("edits, pins and deletes entries through the host", async () => {
		render(<MemorySettings />)
		const field = await screen.findByLabelText("Memory text")
		fireEvent.change(field, { target: { value: "Always target stage after CI" } })
		fireEvent.click(screen.getByText("Save edit"))
		await waitFor(() =>
			expect(mocks.request).toHaveBeenCalledWith({
				action: "edit",
				id: "repo:1",
				patch: { text: "Always target stage after CI" },
			}),
		)
		await waitFor(() => expect((screen.getByText("Pin") as HTMLButtonElement).disabled).toBe(false))
		fireEvent.click(screen.getByText("Pin"))
		await waitFor(() => expect(mocks.request).toHaveBeenCalledWith({ action: "edit", id: "repo:1", patch: { pinned: true } }))
		await waitFor(() => expect((screen.getByText("Delete") as HTMLButtonElement).disabled).toBe(false))
		fireEvent.click(screen.getByText("Delete"))
		await waitFor(() => expect(mocks.request).toHaveBeenCalledWith({ action: "delete", id: "repo:1" }))
	})
	it("shows host errors and opens all memory scopes", async () => {
		render(<MemorySettings />)
		await screen.findByLabelText("Memory text")
		mocks.request.mockRejectedValueOnce(new Error("Invalid memory budget"))
		const field = screen.getByLabelText("Memory budget (tokens or %)")
		fireEvent.change(field, { target: { value: "invalid" } })
		fireEvent.blur(field)
		expect(await screen.findByRole("alert")).toHaveTextContent("Invalid memory budget")
		for (const label of ["Open repository memory", "Open group memory", "Open your memory"])
			fireEvent.click(screen.getByText(label))
		expect(mocks.open.mock.calls).toHaveLength(3)
		fireEvent.click(screen.getByLabelText("Search earlier conversations"))
		expect(mocks.update).toHaveBeenCalledWith("memoryConversationSearchEnabled", false)
	})
})
