/**
 * The Execute plan button's model menu: which model a plan can be run on, and
 * what the button calls it. The choices and what each one switches act mode to
 * are shared with the extension (`@shared/planExecution`).
 */

import type { ModelInfo } from "@shared/api"
import { PLAN_EXECUTION_CHOICES, type PlanExecutionChoice, planExecutionModelId } from "@shared/planExecution"
import { canonicalPlinyModelId, isPlinyBalanceAutoModelId, PLINY_FREE_AUTO_MODEL_ID } from "@shared/pliny"

interface PlanExecutionOption {
	choice: PlanExecutionChoice
	/** The model act mode will run the plan on. */
	modelId: string
	/** That model's short name, as shown on the button and in the menu. */
	modelLabel: string
	/** What the choice means, shown next to the model in the menu. */
	description: string
}

interface PlanExecutionMenu {
	/** What the main click does: the remembered choice, and the model it runs on now. */
	current: PlanExecutionOption
	/** The menu rows, in display order. */
	options: PlanExecutionOption[]
}

/**
 * The two routers go by their product names, FreeAuto and BalanceAuto; every
 * other model by its catalog name, or its id until the catalog has loaded.
 */
function planExecutionModelLabel(modelId: string, models: Record<string, ModelInfo>): string {
	if (canonicalPlinyModelId(modelId) === PLINY_FREE_AUTO_MODEL_ID) {
		return "FreeAuto"
	}
	if (isPlinyBalanceAutoModelId(modelId)) {
		return "BalanceAuto"
	}
	return models[modelId]?.name || modelId
}

const DESCRIPTIONS: Record<PlanExecutionChoice, string> = {
	actModel: "Agent mode model (default)",
	freeAuto: "free models only",
	balanceAuto: "paid models for hard steps",
	planModel: "same model as the plan",
}

/**
 * The button's default and its menu rows.
 *
 * The act-mode model comes first, then FreeAuto, BalanceAuto and the model
 * that wrote the plan. BalanceAuto can spend money, so like the model picker
 * it is offered only when paid models are unlocked, or when it is already the
 * remembered choice. A row that would run the same model as an earlier one is
 * left out: with FreeAuto as the act-mode model, a second FreeAuto row would
 * only raise the question of how the two differ.
 */
export function buildPlanExecutionMenu(input: {
	planModelId: string | undefined
	actModelId: string | undefined
	models: Record<string, ModelInfo>
	remembered: PlanExecutionChoice
	paidModelsUnlocked: boolean
}): PlanExecutionMenu {
	const { planModelId, actModelId, models, remembered, paidModelsUnlocked } = input
	const toOption = (choice: PlanExecutionChoice): PlanExecutionOption => {
		const modelId = planExecutionModelId(choice, { planModelId, actModelId })
		return { choice, modelId, modelLabel: planExecutionModelLabel(modelId, models), description: DESCRIPTIONS[choice] }
	}

	const options: PlanExecutionOption[] = []
	for (const choice of PLAN_EXECUTION_CHOICES) {
		if (choice === "balanceAuto" && !paidModelsUnlocked && remembered !== "balanceAuto") {
			continue
		}
		const option = toOption(choice)
		if (!options.some((earlier) => earlier.modelId === option.modelId)) {
			options.push(option)
		}
	}
	return { current: toOption(remembered), options }
}
