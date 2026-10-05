// Execute plan on a chosen model: preparePlanExecution against the real
// provider config store, so the tests cover what a commit does to the plan-mode
// model under the "separate models for plan and act" setting.

import type { ApiConfiguration } from "@shared/api"
import type { PlanExecutionChoice } from "@shared/planExecution"
import { isPlinyFreeModelId, PLINY_BALANCE_AUTO_MODEL_ID, PLINY_FREE_AUTO_MODEL_ID } from "@shared/pliny"
import { beforeEach, describe, expect, it, vi } from "vitest"

const SONNET = "snps-aws-bedrock/aws-claude-sonnet-4.6"
const KIMI = "snps-provider/kimi-k2.6"

const mocks = vi.hoisted(() => {
	type State = Record<string, unknown>
	let state: State = {}
	let rememberedChoice = "actModel"
	return {
		reset(next: State, remembered = "actModel"): void {
			state = { ...next }
			rememberedChoice = remembered
		},
		state: () => state,
		stateManager: {
			getApiConfiguration: () => ({ ...state }),
			getGlobalSettingsKey: (key: string) => state[key],
			setGlobalState: (key: string, value: unknown) => {
				state = { ...state, [key]: value }
			},
			setGlobalStateBatch: (updates: State) => {
				state = { ...state, ...updates }
			},
			flushPendingState: async () => undefined,
		},
		getPlanExecutionChoice: () => rememberedChoice,
		setPlanExecutionChoice: async (choice: string) => {
			rememberedChoice = choice
		},
	}
})

vi.mock("@/shared/services/Logger", () => ({
	Logger: { debug: vi.fn(), error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}))

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: { get: () => mocks.stateManager },
}))

vi.mock("./provider-migration", () => ({
	getProviderSettingsManager: () => ({
		getProviderSettings: () => undefined,
		saveProviderSettings: vi.fn(),
	}),
}))

const setPlanExecutionChoice = vi.fn(mocks.setPlanExecutionChoice)
vi.mock("@/hosts/vscode/plan-settings", () => ({
	getPlanExecutionChoice: () => mocks.getPlanExecutionChoice(),
	setPlanExecutionChoice: (choice: string) => setPlanExecutionChoice(choice),
}))

async function setup(state: Partial<ApiConfiguration> & { planActSeparateModelsSetting?: boolean }, remembered?: string) {
	mocks.reset(state, remembered)
	const { createProviderConfigStore } = await import("./model-catalog/store")
	const { preparePlanExecution } = await import("./plan-execution")
	const store = createProviderConfigStore()
	const commitSelection = vi.spyOn(store, "commitSelection")
	const controller = {
		stateManager: mocks.stateManager,
		getProviderConfigStore: () => store,
		getProviderCatalog: () => ({ peekModels: () => undefined }),
		postStateToWebview: vi.fn(async () => undefined),
	}
	return {
		commitSelection,
		controller,
		prepare: (choice: PlanExecutionChoice) =>
			preparePlanExecution(controller as unknown as Parameters<typeof preparePlanExecution>[0], choice),
	}
}

describe("preparePlanExecution", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("moves act mode to FreeAuto and leaves the planner's model alone", async () => {
		// One model for both modes: a plain commit would write plan mode too.
		const { prepare, controller } = await setup({
			planModeApiModelId: SONNET,
			actModeApiModelId: SONNET,
			planActSeparateModelsSetting: false,
		})

		await prepare("freeAuto")

		expect(mocks.state().actModeApiModelId).toBe(PLINY_FREE_AUTO_MODEL_ID)
		expect(mocks.state().planModeApiModelId).toBe(SONNET)
		// The modes now differ on purpose, so later picks must not sync them again.
		expect(mocks.state().planActSeparateModelsSetting).toBe(true)
		expect(controller.postStateToWebview).toHaveBeenCalled()
		expect(setPlanExecutionChoice).toHaveBeenCalledWith("freeAuto")
	})

	it("is what the act-mode session of the mode switch is built with", async () => {
		const { prepare } = await setup({ planModeApiModelId: SONNET, actModeApiModelId: SONNET })
		const { resolveModelId } = await import("./cline-session-factory")

		await prepare("freeAuto")

		// buildSessionConfig resolves the mode's model this way when the mode
		// coordinator rebuilds the session for act mode.
		const apiConfiguration = mocks.stateManager.getApiConfiguration() as ApiConfiguration
		expect(resolveModelId("act", apiConfiguration)).toBe(PLINY_FREE_AUTO_MODEL_ID)
		expect(resolveModelId("plan", apiConfiguration)).toBe(SONNET)
	})

	it("moves act mode to BalanceAuto", async () => {
		const { prepare } = await setup({
			planModeApiModelId: SONNET,
			actModeApiModelId: PLINY_FREE_AUTO_MODEL_ID,
			planActSeparateModelsSetting: true,
		})

		await prepare("balanceAuto")

		expect(mocks.state().actModeApiModelId).toBe(PLINY_BALANCE_AUTO_MODEL_ID)
		expect(mocks.state().planModeApiModelId).toBe(SONNET)
	})

	it("moves act mode to the model that wrote the plan", async () => {
		const { prepare } = await setup({
			planModeApiModelId: SONNET,
			actModeApiModelId: KIMI,
			planActSeparateModelsSetting: true,
		})

		await prepare("planModel")

		expect(mocks.state().actModeApiModelId).toBe(SONNET)
		expect(mocks.state().planModeApiModelId).toBe(SONNET)
		expect(setPlanExecutionChoice).toHaveBeenCalledWith("planModel")
	})

	it("does not turn on separate models when the executor is the planner's model", async () => {
		// The modes drifted apart while the setting says they share a model.
		const { prepare } = await setup({
			planModeApiModelId: SONNET,
			actModeApiModelId: KIMI,
			planActSeparateModelsSetting: false,
		})

		await prepare("planModel")

		expect(mocks.state().actModeApiModelId).toBe(SONNET)
		expect(mocks.state().planModeApiModelId).toBe(SONNET)
		expect(mocks.state().planActSeparateModelsSetting).toBe(false)
	})

	it("changes no model for the act-mode default, and remembers it when it replaces another choice", async () => {
		const { prepare, commitSelection, controller } = await setup(
			{ planModeApiModelId: SONNET, actModeApiModelId: KIMI, planActSeparateModelsSetting: true },
			"freeAuto",
		)
		const before = mocks.state()

		await prepare("actModel")

		expect(commitSelection).not.toHaveBeenCalled()
		expect(controller.postStateToWebview).not.toHaveBeenCalled()
		expect(mocks.state()).toEqual(before)
		expect(setPlanExecutionChoice).toHaveBeenCalledWith("actModel")
	})

	it("writes nothing when act mode is already on the chosen model and the choice is the remembered one", async () => {
		const { prepare, commitSelection } = await setup(
			{ planModeApiModelId: SONNET, actModeApiModelId: PLINY_FREE_AUTO_MODEL_ID, planActSeparateModelsSetting: true },
			"freeAuto",
		)

		await prepare("freeAuto")

		expect(commitSelection).not.toHaveBeenCalled()
		expect(setPlanExecutionChoice).not.toHaveBeenCalled()
	})

	it("treats an unset act-mode model as the default model", async () => {
		const { prepare, commitSelection } = await setup({ planModeApiModelId: SONNET })

		await prepare("freeAuto")

		// The default is FreeAuto, so there is nothing to switch.
		expect(commitSelection).not.toHaveBeenCalled()
	})

	it("still prepares the execution when the choice cannot be remembered", async () => {
		const { prepare } = await setup({ planModeApiModelId: SONNET, actModeApiModelId: SONNET })
		setPlanExecutionChoice.mockRejectedValueOnce(new Error("settings.json is read-only"))

		await expect(prepare("freeAuto")).resolves.toBeUndefined()

		expect(mocks.state().actModeApiModelId).toBe(PLINY_FREE_AUTO_MODEL_ID)
	})

	it("fails without remembering the choice when the model cannot be committed", async () => {
		const { prepare, commitSelection } = await setup({ planModeApiModelId: SONNET, actModeApiModelId: SONNET })
		commitSelection.mockImplementationOnce(() => {
			throw new Error("providers.json is locked")
		})

		await expect(prepare("freeAuto")).rejects.toThrow("providers.json is locked")

		expect(setPlanExecutionChoice).not.toHaveBeenCalled()
	})

	// The conversation budget is checked before every model call against the
	// active mode's model as stored in state (SdkController.checkSpendingLimit
	// skips it only when isPlinyFreeModelId says that model is free). These pin
	// what it will read once the mode switches to act.
	describe("what the budget check sees after the switch", () => {
		it("a paid planner handing over to FreeAuto leaves a free act-mode model", async () => {
			const { prepare } = await setup({ planModeApiModelId: SONNET, actModeApiModelId: SONNET })

			await prepare("freeAuto")

			expect(isPlinyFreeModelId(mocks.state().actModeApiModelId as string)).toBe(true)
			expect(isPlinyFreeModelId(mocks.state().planModeApiModelId as string)).toBe(false)
		})

		it("a free planner handing over to BalanceAuto leaves a model the budget applies to", async () => {
			const { prepare } = await setup({
				planModeApiModelId: PLINY_FREE_AUTO_MODEL_ID,
				actModeApiModelId: PLINY_FREE_AUTO_MODEL_ID,
			})

			await prepare("balanceAuto")

			expect(isPlinyFreeModelId(mocks.state().actModeApiModelId as string)).toBe(false)
		})

		it("executing on a paid planner's model from a free act mode leaves a model the budget applies to", async () => {
			const { prepare } = await setup({
				planModeApiModelId: SONNET,
				actModeApiModelId: PLINY_FREE_AUTO_MODEL_ID,
				planActSeparateModelsSetting: true,
			})

			await prepare("planModel")

			expect(isPlinyFreeModelId(mocks.state().actModeApiModelId as string)).toBe(false)
		})
	})
})
