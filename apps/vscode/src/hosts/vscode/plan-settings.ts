import * as vscode from "vscode"
import { DEFAULT_PLAN_EXECUTION_CHOICE, type PlanExecutionChoice, parsePlanExecutionChoice } from "@/shared/planExecution"

/** VS Code settings section that holds every `plinycode.plan.*` setting. */
const PLAN_SETTINGS_SECTION = "plinycode.plan"

/**
 * `plinycode.plan.executeWith`: the model the Execute plan button runs a plan
 * on. The button's menu writes it, so the last choice is the button's default.
 */
const EXECUTE_WITH_SETTING = "executeWith"

/** The full setting id, for configuration-change listeners. */
export const PLAN_EXECUTE_WITH_SETTING_ID = `${PLAN_SETTINGS_SECTION}.${EXECUTE_WITH_SETTING}`

/** The remembered Execute plan choice. An unknown value reads as the default. */
export function getPlanExecutionChoice(): PlanExecutionChoice {
	try {
		const value = vscode.workspace.getConfiguration(PLAN_SETTINGS_SECTION).get<string>(EXECUTE_WITH_SETTING)
		return parsePlanExecutionChoice(value) ?? DEFAULT_PLAN_EXECUTION_CHOICE
	} catch {
		// Hosts without VS Code's configuration API (standalone) keep the default.
		return DEFAULT_PLAN_EXECUTION_CHOICE
	}
}

export async function setPlanExecutionChoice(choice: PlanExecutionChoice): Promise<void> {
	await vscode.workspace
		.getConfiguration(PLAN_SETTINGS_SECTION)
		.update(EXECUTE_WITH_SETTING, choice, vscode.ConfigurationTarget.Global)
}
