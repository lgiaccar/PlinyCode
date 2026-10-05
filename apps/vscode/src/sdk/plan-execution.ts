/**
 * Execute plan on a chosen model (docs/plan-mode.md).
 *
 * The Execute plan button can name the model the plan runs on: FreeAuto,
 * BalanceAuto, or the model that wrote the plan, instead of whatever act mode
 * is set to. Preparing the execution makes that model act mode's selection
 * before the mode switch rebuilds the session, and remembers the choice as the
 * button's default.
 *
 * Model selection is global, not per conversation, so the switch outlives the
 * plan: act mode stays on the chosen model until the user picks another.
 *
 * The conversation budget needs nothing extra. It is checked before every
 * model call against the active mode's model as stored in state at that moment
 * (SdkController.checkSpendingLimit), so a paid executor is held to the budget
 * from its first call, whatever the planner cost, and a free one is exempt as
 * free models always are.
 */

import { commitModelSelection } from "@/core/controller/models/commitModelSelection"
import type { ProviderCatalogController } from "@/core/controller/models/providerCatalogShared"
import type { StateManager } from "@/core/storage/StateManager"
import { getPlanExecutionChoice, setPlanExecutionChoice } from "@/hosts/vscode/plan-settings"
import { type PlanExecutionChoice, planExecutionModelId } from "@/shared/planExecution"
import { PLINY_DEFAULT_MODEL_ID, PLINY_PROVIDER_ID } from "@/shared/pliny"
import { CommitModelSelectionRequest } from "@/shared/proto/cline/models"
import { Logger } from "@/shared/services/Logger"

interface PlanExecutionController extends ProviderCatalogController {
	stateManager: Pick<
		StateManager,
		"getApiConfiguration" | "getGlobalSettingsKey" | "setGlobalState" | "setGlobalStateBatch" | "flushPendingState"
	>
	postStateToWebview(): Promise<void>
}

/**
 * Points act mode at the model `choice` names and remembers the choice. Call
 * it while still in plan mode, right before switching to act mode.
 *
 * Throws when the model cannot be committed, so the caller does not go on to
 * execute the plan on a model the user did not ask for.
 */
export async function preparePlanExecution(controller: PlanExecutionController, choice: PlanExecutionChoice): Promise<void> {
	const { stateManager } = controller
	const apiConfiguration = stateManager.getApiConfiguration()
	// An unset model reads as the default, as it does everywhere else.
	const planModelId = apiConfiguration.planModeApiModelId?.trim() || PLINY_DEFAULT_MODEL_ID
	const actModelId = apiConfiguration.actModeApiModelId?.trim() || PLINY_DEFAULT_MODEL_ID
	const modelId = planExecutionModelId(choice, { planModelId, actModelId })

	if (modelId !== actModelId) {
		if (modelId !== planModelId && !stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")) {
			// With one model for both modes, a commit writes plan mode's model as
			// well, and so would the user's next pick in either mode. The user just
			// chose a different executor than the planner, so say so in the setting:
			// plan mode keeps its model, and Settings shows both.
			stateManager.setGlobalState("planActSeparateModelsSetting", true)
		}
		// The same commit the model picker makes. Plan mode is still the active
		// mode, so it does not retarget the running session; the act-mode session
		// the switch builds next reads the new selection.
		await commitModelSelection(
			controller,
			CommitModelSelectionRequest.create({ providerId: PLINY_PROVIDER_ID, mode: "act", modelId }),
		)
		Logger.log(`[PlanExecution] Act mode set to ${modelId} to execute the plan (${choice})`)
	}

	if (getPlanExecutionChoice() !== choice) {
		try {
			await setPlanExecutionChoice(choice)
		} catch (error) {
			// The plan still runs on the model chosen for it; only the button's
			// default for next time is lost.
			Logger.warn("[PlanExecution] Could not remember the Execute plan choice:", error)
		}
	}
}
