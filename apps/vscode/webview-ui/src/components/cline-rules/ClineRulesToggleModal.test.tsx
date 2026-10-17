import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ClineRulesToggleModal from "./ClineRulesToggleModal"

globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver

const mocks = vi.hoisted(() => ({
	refreshRules: vi.fn(),
	refreshSkills: vi.fn(),
	refreshHooks: vi.fn(),
	refreshAgents: vi.fn(),
	subscribe: vi.fn(),
	unsubscribe: vi.fn(),
	push: undefined as undefined | (() => void),
}))

const setters = vi.hoisted(() => ({
	setGlobalClineRulesToggles: vi.fn(),
	setLocalClineRulesToggles: vi.fn(),
	setLocalCursorRulesToggles: vi.fn(),
	setLocalWindsurfRulesToggles: vi.fn(),
	setLocalAgentsRulesToggles: vi.fn(),
	setLocalCopilotRulesToggles: vi.fn(),
	setGlobalSkillsToggles: vi.fn(),
	setLocalSkillsToggles: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ hooksEnabled: true, ...setters }),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick, "aria-label": ariaLabel }: any) => (
		<span aria-label={ariaLabel} onClick={onClick} role="button">
			{children}
		</span>
	),
	VSCodeLink: ({ children }: any) => <span>{children}</span>,
}))

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: {
		refreshRules: mocks.refreshRules,
		refreshSkills: mocks.refreshSkills,
		refreshHooks: mocks.refreshHooks,
		refreshAgents: mocks.refreshAgents,
		subscribeToCustomizationChanges: mocks.subscribe,
	},
}))

describe("ClineRulesToggleModal", () => {
	beforeEach(() => {
		mocks.refreshRules.mockReset().mockResolvedValue({ tokenCounts: {} })
		mocks.refreshSkills.mockReset().mockResolvedValue({ globalSkills: [], localSkills: [] })
		mocks.refreshHooks.mockReset().mockResolvedValue({ globalHooks: [], workspaceHooks: [] })
		mocks.refreshAgents.mockReset().mockResolvedValue({
			globalAgents: [],
			localAgents: [
				{
					name: "reviewer",
					description: "Reviews diffs",
					path: "/repo/.cline/agents/reviewer.md",
					enabled: true,
					model: "",
					toolName: "subagent_reviewer",
					error: "",
				},
			],
		})
		mocks.unsubscribe.mockReset()
		mocks.subscribe.mockReset().mockImplementation((_request, callbacks: { onResponse: () => void }) => {
			mocks.push = callbacks.onResponse
			return mocks.unsubscribe
		})
	})

	it("refreshes on open and on each change the extension pushes, without polling", async () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval")
		render(<ClineRulesToggleModal />)
		fireEvent.click(screen.getByRole("button", { name: "Show Customize" }))

		await waitFor(() => expect(mocks.refreshRules).toHaveBeenCalledTimes(1))
		expect(mocks.subscribe).toHaveBeenCalledTimes(1)

		fireEvent.click(screen.getByRole("button", { name: "Agents" }))
		await waitFor(() => expect(screen.getByText("subagent_reviewer")).toBeTruthy())
		expect(mocks.refreshAgents).toHaveBeenCalledTimes(1)
		expect(mocks.refreshSkills).not.toHaveBeenCalled()

		act(() => mocks.push?.())
		await waitFor(() => expect(mocks.refreshAgents).toHaveBeenCalledTimes(2))
		expect(mocks.refreshRules).toHaveBeenCalledTimes(2)
		// Switching tabs keeps the one subscription.
		expect(mocks.subscribe).toHaveBeenCalledTimes(1)
		// waitFor polls with setInterval itself; the panel used a 1 s interval.
		expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 1000)).toEqual([])
		setIntervalSpy.mockRestore()
	})

	it("unsubscribes when the panel closes", async () => {
		render(<ClineRulesToggleModal />)
		fireEvent.click(screen.getByRole("button", { name: "Show Customize" }))
		await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1))
		fireEvent.click(screen.getByRole("button", { name: "Hide Customize" }))
		expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
	})
})
