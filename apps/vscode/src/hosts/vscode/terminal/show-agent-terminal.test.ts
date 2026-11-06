import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	terminals: [] as Array<{
		id: number
		busy: boolean
		lastActive: number
		lastCommand: string
		terminal: { show: ReturnType<typeof vi.fn> }
	}>,
	showQuickPick: vi.fn(),
	showInformationMessage: vi.fn(),
}))

vi.mock("vscode", () => ({
	window: {
		showQuickPick: mocks.showQuickPick,
		showInformationMessage: mocks.showInformationMessage,
	},
}))
vi.mock("./VscodeTerminalRegistry", () => ({
	TerminalRegistry: { getAllTerminals: () => mocks.terminals },
}))

import { showAgentTerminal } from "./show-agent-terminal"

describe("showAgentTerminal", () => {
	beforeEach(() => {
		mocks.terminals = []
		mocks.showQuickPick.mockReset()
		mocks.showInformationMessage.mockReset()
	})

	it("reveals a single command terminal only on request", async () => {
		const show = vi.fn()
		mocks.terminals = [{ id: 1, busy: true, lastActive: 1, lastCommand: "bun test", terminal: { show } }]

		await showAgentTerminal()

		expect(show).toHaveBeenCalledOnce()
		expect(mocks.showQuickPick).not.toHaveBeenCalled()
	})

	it("lets the user choose when several commands have terminals", async () => {
		const first = { id: 1, busy: false, lastActive: 2, lastCommand: "bun test", terminal: { show: vi.fn() } }
		const second = { id: 2, busy: true, lastActive: 1, lastCommand: "bun run build", terminal: { show: vi.fn() } }
		mocks.terminals = [first, second]
		mocks.showQuickPick.mockImplementation(async (items) => items[0])

		await showAgentTerminal()

		expect(mocks.showQuickPick.mock.calls[0][0][0].label).toBe("PlinyCode terminal 2")
		expect(second.terminal.show).toHaveBeenCalledOnce()
		expect(first.terminal.show).not.toHaveBeenCalled()
	})
})
