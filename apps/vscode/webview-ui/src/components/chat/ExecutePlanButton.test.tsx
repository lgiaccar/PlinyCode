import type { PlanExecutionChoice } from "@shared/planExecution"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ExecutePlanButton from "./ExecutePlanButton"

const SONNET = "snps-aws-bedrock/aws-claude-sonnet-4.6"
const OPUS = "snps-aws-bedrock/aws-claude-opus-4.8"
const FREE_AUTO = "pliny/auto-free"
const BALANCE_AUTO = "pliny/auto-paid-balanced"

const state = vi.hoisted(() => ({
	extension: {} as Record<string, unknown>,
	paidModelsUnlocked: false,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => state.extension,
}))
vi.mock("@/components/settings/utils/plinyModelFilter", () => ({
	usePlinyUnlockPaidModels: () => [state.paidModelsUnlocked, vi.fn()],
}))

function setState(input: {
	planModelId?: string
	actModelId?: string
	remembered?: PlanExecutionChoice
	paidModelsUnlocked?: boolean
}) {
	state.paidModelsUnlocked = input.paidModelsUnlocked ?? false
	state.extension = {
		apiConfiguration: { planModeApiModelId: input.planModelId, actModeApiModelId: input.actModelId },
		planExecutionChoice: input.remembered,
		providerModelsByProvider: {
			pliny: {
				models: {
					[SONNET]: { name: "Claude Sonnet 4.6" },
					[OPUS]: { name: "Claude Opus 4.8" },
					[FREE_AUTO]: { name: "auto-free (router)" },
					[BALANCE_AUTO]: { name: "auto-paid-balanced (router)" },
				},
			},
		},
	}
}

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "Execute with another model" }))
const menuRows = () => screen.getAllByRole("menuitemradio").map((row) => row.textContent)
const checkedRows = () =>
	screen
		.getAllByRole("menuitemradio")
		.filter((row) => row.getAttribute("aria-checked") === "true")
		.map((row) => row.textContent)

describe("ExecutePlanButton", () => {
	beforeEach(() => {
		setState({ planModelId: SONNET, actModelId: SONNET })
	})

	it("names the act-mode model and executes on it by default", () => {
		const onExecute = vi.fn()
		render(<ExecutePlanButton onExecute={onExecute} />)

		fireEvent.click(screen.getByRole("button", { name: "Execute plan · Claude Sonnet 4.6" }))

		expect(onExecute).toHaveBeenCalledTimes(1)
		expect(onExecute).toHaveBeenCalledWith("actModel")
		expect(screen.queryByRole("menu")).toBeNull()
	})

	it("offers the act-mode model as the default and FreeAuto, and keeps BalanceAuto with the paid models", () => {
		const { unmount } = render(<ExecutePlanButton onExecute={vi.fn()} />)
		openMenu()

		expect(menuRows()).toEqual(["Claude Sonnet 4.6act mode model (default)", "FreeAutofree models only"])
		expect(checkedRows()).toEqual(["Claude Sonnet 4.6act mode model (default)"])
		unmount()

		setState({ planModelId: SONNET, actModelId: SONNET, paidModelsUnlocked: true })
		render(<ExecutePlanButton onExecute={vi.fn()} />)
		openMenu()

		expect(menuRows()).toEqual([
			"Claude Sonnet 4.6act mode model (default)",
			"FreeAutofree models only",
			"BalanceAutopaid models for hard steps",
		])
	})

	it("offers the plan's model only when act mode runs on a different one", () => {
		setState({ planModelId: OPUS, actModelId: SONNET })
		render(<ExecutePlanButton onExecute={vi.fn()} />)
		openMenu()

		expect(menuRows()).toEqual([
			"Claude Sonnet 4.6act mode model (default)",
			"FreeAutofree models only",
			"Claude Opus 4.8same model as the plan",
		])
	})

	it("executes on the model picked from the menu and closes it", () => {
		const onExecute = vi.fn()
		render(<ExecutePlanButton onExecute={onExecute} />)
		openMenu()

		fireEvent.click(screen.getByRole("menuitemradio", { name: /FreeAuto/ }))

		expect(onExecute).toHaveBeenCalledTimes(1)
		expect(onExecute).toHaveBeenCalledWith("freeAuto")
		expect(screen.queryByRole("menu")).toBeNull()
	})

	it("makes the remembered choice the main click and says so on the button", () => {
		// Remembered from an earlier plan; act mode has been moved to Sonnet since.
		setState({ planModelId: OPUS, actModelId: SONNET, remembered: "freeAuto" })
		const onExecute = vi.fn()
		render(<ExecutePlanButton onExecute={onExecute} />)

		fireEvent.click(screen.getByRole("button", { name: "Execute plan · FreeAuto" }))
		expect(onExecute).toHaveBeenCalledWith("freeAuto")

		openMenu()
		expect(checkedRows()).toEqual(["FreeAutofree models only"])
	})

	it("shows one row per model, and keeps sending the remembered choice from the main click", () => {
		// Executing with FreeAuto made it the act-mode model as well.
		setState({ planModelId: OPUS, actModelId: FREE_AUTO, remembered: "freeAuto" })
		const onExecute = vi.fn()
		render(<ExecutePlanButton onExecute={onExecute} />)

		fireEvent.click(screen.getByRole("button", { name: "Execute plan · FreeAuto" }))
		expect(onExecute).toHaveBeenLastCalledWith("freeAuto")

		openMenu()
		expect(menuRows()).toEqual(["FreeAutoact mode model (default)", "Claude Opus 4.8same model as the plan"])
		expect(checkedRows()).toEqual(["FreeAutoact mode model (default)"])
	})

	it("labels a remembered 'same model as the plan' with the plan's model", () => {
		setState({ planModelId: OPUS, actModelId: FREE_AUTO, remembered: "planModel" })
		const onExecute = vi.fn()
		render(<ExecutePlanButton onExecute={onExecute} />)

		fireEvent.click(screen.getByRole("button", { name: "Execute plan · Claude Opus 4.8" }))

		expect(onExecute).toHaveBeenCalledWith("planModel")
	})

	it("keeps a remembered BalanceAuto on the button and in the menu while paid models are locked", () => {
		setState({ planModelId: SONNET, actModelId: FREE_AUTO, remembered: "balanceAuto", paidModelsUnlocked: false })
		render(<ExecutePlanButton onExecute={vi.fn()} />)

		expect(screen.getByRole("button", { name: "Execute plan · BalanceAuto" })).toBeInTheDocument()
		openMenu()
		expect(checkedRows()).toEqual(["BalanceAutopaid models for hard steps"])
	})

	it("falls back to the model id until the catalog has loaded", () => {
		setState({ planModelId: SONNET, actModelId: SONNET })
		state.extension.providerModelsByProvider = {}
		render(<ExecutePlanButton onExecute={vi.fn()} />)

		expect(screen.getByRole("button", { name: `Execute plan · ${SONNET}` })).toBeInTheDocument()
	})

	it("closes the menu on Escape and on a click outside without executing", () => {
		const onExecute = vi.fn()
		render(<ExecutePlanButton onExecute={onExecute} />)

		openMenu()
		fireEvent.keyDown(document, { key: "Escape" })
		expect(screen.queryByRole("menu")).toBeNull()

		openMenu()
		fireEvent.mouseDown(document.body)
		expect(screen.queryByRole("menu")).toBeNull()
		expect(onExecute).not.toHaveBeenCalled()
	})
})
