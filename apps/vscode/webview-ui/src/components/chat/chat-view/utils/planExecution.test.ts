import type { ModelInfo } from "@shared/api"
import { describe, expect, it } from "vitest"
import { buildPlanExecutionMenu } from "./planExecution"

const SONNET = "snps-aws-bedrock/aws-claude-sonnet-4.6"
const OPUS = "snps-aws-bedrock/aws-claude-opus-4.8"
const FREE_AUTO = "pliny/auto-free"
const FREE_AUTO_FAST = "pliny/auto-free-fast"
const BALANCE_AUTO = "pliny/auto-paid-balanced"

const models = {
	[SONNET]: { name: "Claude Sonnet 4.6" },
	[OPUS]: { name: "Claude Opus 4.8" },
	[FREE_AUTO]: { name: "auto-free (router)" },
	[FREE_AUTO_FAST]: { name: "auto-free-fast (router)" },
	[BALANCE_AUTO]: { name: "auto-paid-balanced (router)" },
} as Record<string, ModelInfo>

describe("the model's name on the button", () => {
	// The act-mode model is what the default choice names.
	const label = (actModelId: string) =>
		buildPlanExecutionMenu({
			planModelId: SONNET,
			actModelId,
			models,
			remembered: "actModel",
			paidModelsUnlocked: false,
		}).current.modelLabel

	it("calls the two routers FreeAuto and BalanceAuto, under their old ids too", () => {
		expect(label(FREE_AUTO)).toBe("FreeAuto")
		expect(label("pliny/free-auto")).toBe("FreeAuto")
		expect(label(BALANCE_AUTO)).toBe("BalanceAuto")
		expect(label("pliny/balance-auto")).toBe("BalanceAuto")
	})

	it("keeps the other FreeAuto profiles apart from the default one", () => {
		expect(label(FREE_AUTO_FAST)).toBe("auto-free-fast (router)")
	})

	it("uses the catalog name, or the id for a model the catalog does not list", () => {
		expect(label(SONNET)).toBe("Claude Sonnet 4.6")
		expect(label("azure-openai/gpt-5.2")).toBe("azure-openai/gpt-5.2")
	})
})

describe("buildPlanExecutionMenu", () => {
	const build = (input: Partial<Parameters<typeof buildPlanExecutionMenu>[0]>) =>
		buildPlanExecutionMenu({
			planModelId: SONNET,
			actModelId: SONNET,
			models,
			remembered: "actModel",
			paidModelsUnlocked: false,
			...input,
		})
	const rows = (menu: ReturnType<typeof build>) => menu.options.map((option) => [option.choice, option.modelId])

	it("resolves each choice to the model act mode would run on", () => {
		const menu = build({ planModelId: OPUS, actModelId: FREE_AUTO_FAST, paidModelsUnlocked: true })

		expect(rows(menu)).toEqual([
			["actModel", FREE_AUTO_FAST],
			["freeAuto", FREE_AUTO],
			["balanceAuto", BALANCE_AUTO],
			["planModel", OPUS],
		])
		expect(menu.current).toMatchObject({ choice: "actModel", modelId: FREE_AUTO_FAST })
	})

	it("offers BalanceAuto only with the paid unlock, or when it is the remembered choice", () => {
		expect(rows(build({}))).toEqual([
			["actModel", SONNET],
			["freeAuto", FREE_AUTO],
		])
		expect(rows(build({ paidModelsUnlocked: true }))).toContainEqual(["balanceAuto", BALANCE_AUTO])
		expect(rows(build({ remembered: "balanceAuto" }))).toContainEqual(["balanceAuto", BALANCE_AUTO])
	})

	it("offers the plan's model only when it is not the act-mode model", () => {
		expect(rows(build({ planModelId: OPUS }))).toContainEqual(["planModel", OPUS])
		expect(rows(build({})).map(([choice]) => choice)).not.toContain("planModel")
	})

	it("leaves out a row that would run the same model as an earlier one", () => {
		// The default setup: FreeAuto everywhere.
		expect(rows(build({ planModelId: FREE_AUTO, actModelId: FREE_AUTO, paidModelsUnlocked: true }))).toEqual([
			["actModel", FREE_AUTO],
			["balanceAuto", BALANCE_AUTO],
		])
		// The plan was written by BalanceAuto: one BalanceAuto row, not two.
		expect(rows(build({ planModelId: BALANCE_AUTO, paidModelsUnlocked: true }))).toEqual([
			["actModel", SONNET],
			["freeAuto", FREE_AUTO],
			["balanceAuto", BALANCE_AUTO],
		])
	})

	it("treats unset models as the default model", () => {
		const menu = build({ planModelId: undefined, actModelId: undefined })

		expect(rows(menu)).toEqual([["actModel", FREE_AUTO]])
		expect(menu.current.modelLabel).toBe("FreeAuto")
	})

	it("keeps the remembered choice as the default even when its row is merged into an earlier one", () => {
		// FreeAuto was picked for an earlier plan, which also made it the act-mode model.
		const menu = build({ actModelId: FREE_AUTO, remembered: "freeAuto" })

		expect(rows(menu)).toEqual([
			["actModel", FREE_AUTO],
			["planModel", SONNET],
		])
		// The main click still sends freeAuto, so the default survives a later
		// change of the act-mode model.
		expect(menu.current).toMatchObject({ choice: "freeAuto", modelId: FREE_AUTO, modelLabel: "FreeAuto" })
	})
})
