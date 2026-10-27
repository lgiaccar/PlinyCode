import { RuleScope, SkillInfo } from "@shared/proto/cline/file"
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
	toggleClineRule: vi.fn(),
	toggleCursorRule: vi.fn(),
	toggleWindsurfRule: vi.fn(),
	toggleAgentsRule: vi.fn(),
	toggleCopilotRule: vi.fn(),
	toggleSkill: vi.fn(),
	ruleState: {} as Record<string, Record<string, boolean>>,
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
	useExtensionState: () => ({ hooksEnabled: true, ...setters, ...mocks.ruleState }),
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
		toggleClineRule: mocks.toggleClineRule,
		toggleCursorRule: mocks.toggleCursorRule,
		toggleWindsurfRule: mocks.toggleWindsurfRule,
		toggleAgentsRule: mocks.toggleAgentsRule,
		toggleCopilotRule: mocks.toggleCopilotRule,
		toggleSkill: mocks.toggleSkill,
		subscribeToCustomizationChanges: mocks.subscribe,
	},
}))

describe("ClineRulesToggleModal", () => {
	beforeEach(() => {
		mocks.ruleState = {}
		for (const toggle of [
			mocks.toggleClineRule,
			mocks.toggleCursorRule,
			mocks.toggleWindsurfRule,
			mocks.toggleAgentsRule,
			mocks.toggleCopilotRule,
			mocks.toggleSkill,
		]) {
			toggle.mockReset().mockResolvedValue({})
		}
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

	it("turns off global, workspace and every external rule family with one switch", async () => {
		mocks.ruleState = {
			globalClineRulesToggles: { "/global/rules/style.md": true },
			localClineRulesToggles: { "/repo/.clinerules/style.md": true, "/repo/.clinerules/off.md": false },
			localCursorRulesToggles: { "/repo/.cursor/rules/style.mdc": true },
			localWindsurfRulesToggles: { "/repo/.windsurfrules": true },
			localAgentsRulesToggles: { "/repo/AGENTS.md": true },
			localCopilotRulesToggles: { "/repo/.github/copilot-instructions.md": true },
		}
		render(<ClineRulesToggleModal />)
		fireEvent.click(screen.getByRole("button", { name: "Show Customize" }))
		await waitFor(() => expect(mocks.refreshRules).toHaveBeenCalledTimes(1))
		fireEvent.click(screen.getByRole("switch", { name: "Toggle all rules" }))
		await waitFor(() => expect(mocks.refreshRules).toHaveBeenCalledTimes(2))
		expect(mocks.toggleClineRule).toHaveBeenCalledTimes(2)
		expect(mocks.toggleClineRule.mock.calls.map(([request]) => [request.scope, request.rulePath, request.enabled])).toEqual([
			[RuleScope.GLOBAL, "/global/rules/style.md", false],
			[RuleScope.LOCAL, "/repo/.clinerules/style.md", false],
		])
		for (const toggle of [
			mocks.toggleCursorRule,
			mocks.toggleWindsurfRule,
			mocks.toggleAgentsRule,
			mocks.toggleCopilotRule,
		]) {
			expect(toggle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: false }))
		}
	})

	it("enables global and workspace skills through the persistent per-skill RPC", async () => {
		const globalSkill = SkillInfo.create({ name: "global", path: "/global/skills/check/SKILL.md", enabled: false })
		const localSkill = SkillInfo.create({ name: "local", path: "/repo/.claude/skills/check/SKILL.md", enabled: false })
		mocks.refreshSkills.mockResolvedValue({
			globalSkills: [globalSkill],
			localSkills: [localSkill],
		})
		mocks.toggleSkill.mockImplementation(async ({ isGlobal, enabled }) => {
			if (isGlobal) globalSkill.enabled = enabled
			else localSkill.enabled = enabled
			return {}
		})
		render(<ClineRulesToggleModal />)
		fireEvent.click(screen.getByRole("button", { name: "Show Customize" }))
		fireEvent.click(screen.getByRole("button", { name: "Skills" }))
		await waitFor(() => expect(screen.getByText("0 of 2 enabled")).toBeTruthy())
		fireEvent.click(screen.getByRole("switch", { name: "Toggle all skills" }))
		await waitFor(() => expect(mocks.refreshSkills).toHaveBeenCalledTimes(2))
		expect(mocks.toggleSkill.mock.calls.map(([request]) => [request.isGlobal, request.skillPath, request.enabled])).toEqual([
			[true, "/global/skills/check/SKILL.md", true],
			[false, "/repo/.claude/skills/check/SKILL.md", true],
		])
		await waitFor(() => expect(screen.getByText("2 of 2 enabled")).toBeTruthy())
		fireEvent.click(screen.getByRole("switch", { name: "Toggle all skills" }))
		await waitFor(() => expect(mocks.refreshSkills).toHaveBeenCalledTimes(3))
		expect(mocks.toggleSkill.mock.calls.slice(2).map(([request]) => [request.isGlobal, request.enabled])).toEqual([
			[true, false],
			[false, false],
		])
		expect(screen.getByText("0 of 2 enabled")).toBeTruthy()
	})
})
