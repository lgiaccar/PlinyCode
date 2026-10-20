import type { RouterProfileView, RouterSettingsView } from "@shared/router-tuning"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const KIMI = "snps-provider/kimi-k2.6"
const CODER = "snps-provider/qwen3-coder-480b-a35b-inst-fp8"
const GLM = "snps-provider/GLM-5.2"
const SONNET = "snps-aws-bedrock/global.anthropic.claude-sonnet-5"

function profileView(profile: RouterProfileView["profile"], overrides: Partial<RouterProfileView> = {}): RouterProfileView {
	const paid = profile === "balance"
	return {
		profile,
		label: `label-${profile}`,
		modelId: `pliny/${profile}`,
		base: {
			models: [KIMI, CODER],
			routes: [
				{ name: "huge-context", use: [GLM], effort: "quick", minEstimatedTokens: 180_000 },
				{ name: "default", use: [KIMI, CODER] },
			],
			classifier: { enabled: false, timeoutMs: 8000 },
			guard: { judge: true, judgeTimeoutMs: 6000 },
			health: {
				cooldownMs: 600_000,
				failuresBeforeCooldown: 2,
				maxFailoversPerTurn: 3,
				firstTokenTimeoutMs: 120_000,
				stallTimeoutMs: 90_000,
			},
			escalation: { afterStalls: 3, afterFailedCommands: 6, maxNudgesPerRun: 8 },
			utility: { classifier: CODER, judge: CODER, summarizer: CODER, commit: CODER },
			sticky: true,
			contextMarginRatio: 1.15,
		},
		tuning: {},
		candidates: [
			{ id: KIMI, name: "Kimi K2.6", free: true, contextWindow: 256_000 },
			{ id: CODER, name: "Qwen3 Coder", free: true, contextWindow: 128_000 },
			{ id: GLM, name: "GLM-5.2", free: true, contextWindow: 512_000 },
			...(paid ? [{ id: SONNET, name: "Claude Sonnet 5", free: false }] : []),
		],
		...overrides,
	}
}

const state = vi.hoisted(() => ({
	view: undefined as RouterSettingsView | undefined,
	setRouterTuning: vi.fn(),
	openFile: vi.fn(async () => ({})),
}))

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		getRouterSettings: vi.fn(async () => ({ settingsJson: JSON.stringify(state.view) })),
		setRouterTuning: state.setRouterTuning,
	},
	FileServiceClient: { openFile: state.openFile },
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, onClick }: { children: React.ReactNode; onClick?: (event: React.MouseEvent) => void }) => (
		<a href="#" onClick={onClick}>
			{children}
		</a>
	),
}))

import RouterSettingsSection from "./RouterSettingsSection"

function lastSaved(): { profile: string; tuning: unknown } {
	const request = state.setRouterTuning.mock.calls.at(-1)?.[0] as { profile: string; tuningJson: string }
	return { profile: request.profile, tuning: JSON.parse(request.tuningJson) }
}

async function renderSection() {
	render(<RouterSettingsSection renderSectionHeader={() => null} />)
	await act(async () => {})
}

describe("RouterSettingsSection", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		state.view = { profiles: [profileView("fast"), profileView("default"), profileView("smart"), profileView("balance")] }
		state.setRouterTuning.mockImplementation(async (request: { profile: string; tuningJson: string }) => {
			const tuning = JSON.parse(request.tuningJson)
			state.view = {
				profiles: (state.view?.profiles ?? []).map((entry) =>
					entry.profile === request.profile ? { ...entry, tuning } : entry,
				),
			}
			return { settingsJson: JSON.stringify(state.view) }
		})
	})

	it("shows FreeAuto's rules-file order first and saves a reordered list", async () => {
		await renderSection()
		const order = screen.getByRole("list", { name: "Model order" })
		expect(
			within(order)
				.getAllByRole("listitem")
				.map((row) => row.getAttribute("aria-label")),
		).toEqual(["1. Kimi K2.6", "2. Qwen3 Coder"])

		fireEvent.change(screen.getByLabelText("Add a model to Model order"), { target: { value: GLM } })
		expect(lastSaved()).toEqual({ profile: "default", tuning: { models: [KIMI, CODER, GLM] } })
		await act(async () => {})

		fireEvent.click(screen.getByLabelText("Move GLM-5.2 up"))
		await act(async () => {})
		fireEvent.click(screen.getByLabelText("Move GLM-5.2 up"))
		expect(lastSaved().tuning).toEqual({ models: [GLM, KIMI, CODER] })
		await act(async () => {})
		expect(screen.getByText("Customized")).toBeTruthy()
	})

	it("resets a profile to its rules file", async () => {
		state.view = { profiles: [profileView("default", { tuning: { models: [GLM] } })] }
		await renderSection()
		fireEvent.click(screen.getByText("Reset to rules file"))
		expect(lastSaved()).toEqual({ profile: "default", tuning: {} })
	})

	it("offers paid models only on BalanceAuto", async () => {
		await renderSection()
		const addOptions = () =>
			Array.from((screen.getByLabelText("Add a model to Model order") as HTMLSelectElement).options).map(
				(option) => option.textContent,
			)
		expect(addOptions().some((label) => label?.includes("Claude Sonnet 5"))).toBe(false)

		fireEvent.click(screen.getByRole("tab", { name: "BalanceAuto" }))
		expect(addOptions().some((label) => label?.includes("Claude Sonnet 5 (paid)"))).toBe(true)
	})

	it("saves an advanced setting in its stored unit, and pins the order when exclusive is turned on", async () => {
		await renderSection()
		fireEvent.click(screen.getByText("Advanced"))
		const stall = screen.getByLabelText("Stall timeout (s)")
		fireEvent.change(stall, { target: { value: "30" } })
		fireEvent.blur(stall)
		expect(lastSaved().tuning).toEqual({ health: { stallTimeoutMs: 30_000 } })
		await act(async () => {})

		fireEvent.click(screen.getByLabelText("Use only these models"))
		expect(lastSaved().tuning).toEqual({ health: { stallTimeoutMs: 30_000 }, exclusive: true, models: [KIMI, CODER] })
	})

	it("opens the selected profile's rules file", async () => {
		await renderSection()
		fireEvent.click(screen.getByRole("tab", { name: "FreeAuto Fast" }))
		fireEvent.click(screen.getByText("Open rules file"))
		expect(state.openFile).toHaveBeenCalledWith(expect.objectContaining({ value: "pliny://free-auto-rules/fast" }))
	})
})
