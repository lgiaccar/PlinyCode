import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
	keys: undefined as Record<string, unknown> | undefined,
	setActive: vi.fn(async () => ({})),
	remove: vi.fn(async () => ({})),
	add: vi.fn(async () => ({})),
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
		renamePlinyApiKey: vi.fn(async () => ({})),
		addPlinyApiKey: state.add,
	},
}))

vi.mock("@/hooks/usePlinyBudget", () => ({ invalidatePlinyBudget: state.invalidate }))

import { PlinyApiKeysSection } from "./PlinyApiKeysSection"

describe("PlinyApiKeysSection", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("lists the stored keys by name and last four characters, and switches the active one", async () => {
		state.keys = {
			keys: [
				{ id: "k1", name: "Personal", last4: "0001", active: true, createdAt: 1 },
				{ id: "k2", name: "Team", last4: "0002", active: false, createdAt: 2 },
			],
			source: "settings",
			envKeyPresent: false,
		}
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

	it("names PLINY_API_KEY as the key in use when none is stored, and adds keys through the extension", () => {
		state.keys = { keys: [], source: "environment", envKeyPresent: true }
		render(<PlinyApiKeysSection />)

		expect(screen.getByText(/requests use the PLINY_API_KEY environment variable/)).toBeTruthy()
		fireEvent.click(screen.getByText("Add Key"))
		expect(state.add).toHaveBeenCalled()
	})
})
