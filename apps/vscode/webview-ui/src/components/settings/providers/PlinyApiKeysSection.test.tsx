import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
	keys: undefined as Record<string, unknown> | undefined,
	setActive: vi.fn(async () => ({})),
	remove: vi.fn(async () => ({})),
	add: vi.fn(async (_request: unknown) => ({ error: "" })),
	rename: vi.fn(async (_request: unknown) => ({ error: "" })),
	test: vi.fn(async (_request: unknown) => ({ ok: true, status: 200, message: "Connected", latencyMs: 5 })),
	invalidate: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		subscribeToPlinyApiKeys: (_request: unknown, callbacks: { onResponse: (keys: unknown) => void }) => {
			if (state.keys) callbacks.onResponse(state.keys)
			return () => {}
		},
		setActivePlinyApiKey: state.setActive,
		removePlinyApiKey: state.remove,
		renamePlinyApiKey: state.rename,
		addPlinyApiKey: state.add,
		testPlinyApiKey: state.test,
	},
}))

vi.mock("@/hooks/usePlinyBudget", () => ({ invalidatePlinyBudget: state.invalidate }))

import { PlinyApiKeysSection } from "./PlinyApiKeysSection"

const twoKeys = {
	keys: [
		{ id: "k1", name: "Personal", last4: "0001", active: true, createdAt: 1 },
		{ id: "k2", name: "Team", last4: "0002", active: false, createdAt: 2 },
	],
	source: "settings",
	envKeyPresent: false,
}

describe("PlinyApiKeysSection", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("lists the stored keys by name and last four characters, and switches the active one", async () => {
		state.keys = twoKeys
		render(<PlinyApiKeysSection />)

		expect(screen.getByText("Personal")).toBeTruthy()
		expect(screen.getByText("••••0002")).toBeTruthy()
		expect(screen.getByText("Active")).toBeTruthy()
		expect(state.invalidate).toHaveBeenCalledTimes(1)

		fireEvent.click(screen.getByTitle('Use "Team" for requests'))
		expect(state.setActive).toHaveBeenCalledWith(expect.objectContaining({ value: "k2" }))
		// The buttons stay disabled until the extension has answered.
		await act(async () => {})
		fireEvent.click(screen.getByTitle('Forget "Personal"'))
		expect(state.remove).toHaveBeenCalledWith(expect.objectContaining({ value: "k1" }))
	})

	it("adds a key with its nickname in an inline form, and shows a refusal there", async () => {
		state.keys = { keys: [], source: "environment", envKeyPresent: true }
		render(<PlinyApiKeysSection />)

		expect(screen.getByText(/requests use the PLINY_API_KEY environment variable/)).toBeTruthy()
		fireEvent.click(screen.getByText("Add Key"))
		// The first key is offered the name "Default".
		const name = screen.getByPlaceholderText("e.g. Personal, Team budget") as HTMLInputElement
		expect(name.value).toBe("Default")
		fireEvent.change(name, { target: { value: "Personal" } })
		const key = screen.getByPlaceholderText("Paste the Pliny API key") as HTMLInputElement
		expect(key.type).toBe("password")
		fireEvent.change(key, { target: { value: " sk-test-1234 " } })

		state.add.mockResolvedValueOnce({ error: "The Pliny gateway rejected this key (HTTP 401)." })
		await act(async () => {
			fireEvent.click(screen.getByText("Save"))
		})
		expect(state.add).toHaveBeenCalledWith(expect.objectContaining({ name: "Personal", key: "sk-test-1234" }))
		expect(screen.getByText(/rejected this key/)).toBeTruthy()

		await act(async () => {
			fireEvent.click(screen.getByText("Save"))
		})
		// Stored: the form closes.
		expect(screen.queryByPlaceholderText("Paste the Pliny API key")).toBeNull()
		expect(screen.getByText("Add Key")).toBeTruthy()
	})

	it("tests a key not stored yet from the form", async () => {
		state.keys = { keys: [], source: "none", envKeyPresent: false }
		render(<PlinyApiKeysSection />)
		fireEvent.click(screen.getByText("Add Key"))
		fireEvent.change(screen.getByPlaceholderText("Paste the Pliny API key"), { target: { value: "sk-new" } })
		await act(async () => {
			fireEvent.click(screen.getByText("Test"))
		})
		expect(state.test).toHaveBeenCalledWith(expect.objectContaining({ key: "sk-new", id: "" }))
		expect(screen.getByLabelText("Key test passed")).toBeTruthy()
	})

	it("tests a stored key by id and shows a red light with the reason", async () => {
		state.keys = twoKeys
		state.test.mockResolvedValueOnce({
			ok: false,
			status: 401,
			message: "The Pliny gateway rejected this key.",
			latencyMs: 3,
		})
		render(<PlinyApiKeysSection />)
		expect(screen.getAllByLabelText("Not tested")).toHaveLength(2)

		await act(async () => {
			fireEvent.click(screen.getByTitle('Check "Team" against the Pliny inference server'))
		})
		expect(state.test).toHaveBeenCalledWith(expect.objectContaining({ id: "k2", key: "" }))
		expect(screen.getByLabelText("Key test failed")).toBeTruthy()
		expect(screen.getByText("The Pliny gateway rejected this key.")).toBeTruthy()
	})

	it("renames a key inline", async () => {
		state.keys = twoKeys
		render(<PlinyApiKeysSection />)
		fireEvent.click(screen.getByTitle('Rename "Team"'))
		const field = screen.getByLabelText('New nickname for "Team"')
		fireEvent.change(field, { target: { value: "Team budget" } })
		await act(async () => {
			fireEvent.keyDown(field, { key: "Enter" })
		})
		expect(state.rename).toHaveBeenCalledWith(expect.objectContaining({ id: "k2", name: "Team budget" }))
		expect(screen.queryByLabelText('New nickname for "Team"')).toBeNull()
	})
})
