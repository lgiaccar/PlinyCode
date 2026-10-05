/**
 * Which model the Execute plan button runs a plan on (docs/plan-mode.md).
 *
 * A plan is a set of markdown files, so the model that wrote it does not have
 * to be the one that carries it out: a strong model can plan and a cheaper or
 * free one can execute. The choices are also the values of the
 * `plinycode.plan.executeWith` setting, which remembers the last one picked.
 */

import { PLINY_BALANCE_AUTO_MODEL_ID, PLINY_DEFAULT_MODEL_ID, PLINY_FREE_AUTO_MODEL_ID } from "./pliny"

export const PLAN_EXECUTION_CHOICES = [
	/** Whatever act mode is set to; executing changes no model. */
	"actModel",
	"freeAuto",
	"balanceAuto",
	/** The model plan mode is set to, which wrote the plan. */
	"planModel",
] as const

export type PlanExecutionChoice = (typeof PLAN_EXECUTION_CHOICES)[number]

export const DEFAULT_PLAN_EXECUTION_CHOICE: PlanExecutionChoice = "actModel"

/** The choice a setting value or request field names; undefined for anything else. */
export function parsePlanExecutionChoice(value: unknown): PlanExecutionChoice | undefined {
	return PLAN_EXECUTION_CHOICES.find((choice) => choice === value)
}

/** The model id act mode runs the plan on for `choice`, given the two modes' current models. */
export function planExecutionModelId(choice: PlanExecutionChoice, models: { planModelId?: string; actModelId?: string }): string {
	switch (choice) {
		case "freeAuto":
			return PLINY_FREE_AUTO_MODEL_ID
		case "balanceAuto":
			return PLINY_BALANCE_AUTO_MODEL_ID
		case "planModel":
			return models.planModelId || PLINY_DEFAULT_MODEL_ID
		default:
			return models.actModelId || PLINY_DEFAULT_MODEL_ID
	}
}
