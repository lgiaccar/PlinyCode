import type { ModelTuningMap } from "@shared/model-tuning"
import { SetModelTuningRequest } from "@shared/proto/cline/models"
import { describe, expect, it, vi } from "vitest"
import { type ModelTuningController, setModelTuning } from "../setModelTuning"

function makeController(stored: ModelTuningMap) {
	let state = stored
	const controller = {
		stateManager: {
			reloadGlobalStateKey: vi.fn(() => state),
			setGlobalState: vi.fn((_key: string, value: ModelTuningMap) => {
				state = value
			}),
		},
		postStateToWebview: vi.fn(async () => {}),
		handleModelTuningChanged: vi.fn(),
	}
	return { controller, state: () => state }
}

describe("setModelTuning", () => {
	it("stores the model's tuning next to other models' and rebuilds its session", async () => {
		const { controller, state } = makeController({ other: { thinking: false } })
		await setModelTuning(
			controller as unknown as ModelTuningController,
			SetModelTuningRequest.create({ modelId: "glm", effort: "high", maxInputTokens: 64_000 }),
		)
		expect(state()).toEqual({ other: { thinking: false }, glm: { effort: "high", maxInputTokens: 64_000 } })
		expect(controller.handleModelTuningChanged).toHaveBeenCalledWith("glm")
		expect(controller.postStateToWebview).toHaveBeenCalled()
	})

	it("replaces the previous tuning rather than merging into it", async () => {
		const { controller, state } = makeController({ glm: { effort: "high", maxInputTokens: 64_000 } })
		await setModelTuning(
			controller as unknown as ModelTuningController,
			SetModelTuningRequest.create({ modelId: "glm", thinking: false }),
		)
		expect(state()).toEqual({ glm: { thinking: false } })
	})

	it("removes the entry when nothing valid is left", async () => {
		const { controller, state } = makeController({ glm: { thinking: false }, other: { effort: "low" } })
		await setModelTuning(
			controller as unknown as ModelTuningController,
			SetModelTuningRequest.create({ modelId: "glm", effort: "extreme", maxInputTokens: 10 }),
		)
		expect(state()).toEqual({ other: { effort: "low" } })
	})

	it("rejects a request without a model id", async () => {
		const { controller } = makeController({})
		await expect(
			setModelTuning(controller as unknown as ModelTuningController, SetModelTuningRequest.create({ modelId: " " })),
		).rejects.toThrow("Model ID is required")
	})
})
