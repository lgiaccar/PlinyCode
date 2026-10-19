import { type ModelTuning, type ModelTuningMap, normalizeModelTuning } from "@shared/model-tuning"
import { Empty } from "@shared/proto/cline/common"
import type { SetModelTuningRequest } from "@shared/proto/cline/models"
import type { StateManager } from "@/core/storage/StateManager"

export interface ModelTuningController {
	stateManager: Pick<StateManager, "reloadGlobalStateKey" | "setGlobalState">
	postStateToWebview(): Promise<void>
	handleModelTuningChanged?(modelId: string): void
}

/**
 * Stores the tuning for one model, replacing what it had. Invalid fields are
 * dropped, and a tuning with nothing left removes the model's entry. The
 * session running on that model is rebuilt so the change applies to its next
 * call.
 */
export async function setModelTuning(controller: ModelTuningController, request: SetModelTuningRequest): Promise<Empty> {
	const modelId = request.modelId.trim()
	if (!modelId) {
		throw new Error("Model ID is required")
	}
	const tuning = normalizeModelTuning({
		thinking: request.thinking,
		effort: request.effort,
		maxInputTokens: request.maxInputTokens,
	} satisfies Record<keyof ModelTuning, unknown>)

	// Another window may have tuned other models since this one loaded the map.
	const current = controller.stateManager.reloadGlobalStateKey("modelTuning") ?? {}
	const { [modelId]: _previous, ...rest } = current
	const next: ModelTuningMap = tuning ? { ...rest, [modelId]: tuning } : rest
	controller.stateManager.setGlobalState("modelTuning", next)

	controller.handleModelTuningChanged?.(modelId)
	await controller.postStateToWebview()
	return Empty.create()
}
