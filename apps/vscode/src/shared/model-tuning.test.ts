import { describe, expect, it } from "vitest"
import {
	applyTunedInputBudget,
	describeModelTuning,
	modelTuningFor,
	modelTuningOptions,
	normalizeModelTuning,
	sessionReasoningFor,
	tunedInputTokens,
	tunedReasoning,
} from "./model-tuning"
import { PLINY_FREE_AUTO_MODEL_ID } from "./pliny"

describe("normalizeModelTuning", () => {
	it("keeps valid fields and drops the rest", () => {
		expect(normalizeModelTuning({ thinking: true, effort: "high", maxInputTokens: 64_000.7 })).toEqual({
			thinking: true,
			effort: "high",
			maxInputTokens: 64_000,
		})
		expect(normalizeModelTuning({ thinking: "yes", effort: "max", maxInputTokens: 1_000 })).toBeUndefined()
		expect(normalizeModelTuning(null)).toBeUndefined()
		expect(normalizeModelTuning(["x"])).toBeUndefined()
	})

	it("drops an effort level when reasoning is off", () => {
		expect(normalizeModelTuning({ thinking: false, effort: "high" })).toEqual({ thinking: false })
	})

	it("reads a model's entry from the stored map", () => {
		expect(modelTuningFor({ a: { effort: "low" } }, "a")).toEqual({ effort: "low" })
		expect(modelTuningFor({ a: { effort: "low" } }, "b")).toBeUndefined()
		expect(modelTuningFor(undefined, "a")).toBeUndefined()
	})
})

describe("tunedReasoning", () => {
	it("turns reasoning off without an effort level", () => {
		expect(tunedReasoning({ thinking: false })).toEqual({ thinking: false })
	})

	it("turns reasoning on at the chosen level, medium when none is chosen", () => {
		expect(tunedReasoning({ effort: "high" })).toEqual({ thinking: true, reasoningEffort: "high" })
		expect(tunedReasoning({ thinking: true })).toEqual({ thinking: true, reasoningEffort: "medium" })
	})

	it("asks for nothing when only the context is tuned", () => {
		expect(tunedReasoning({ maxInputTokens: 64_000 })).toBeUndefined()
		expect(tunedReasoning(undefined)).toBeUndefined()
	})

	it("never sets reasoning on a router, whose routes choose it per call", () => {
		expect(sessionReasoningFor(PLINY_FREE_AUTO_MODEL_ID, { thinking: false })).toBeUndefined()
		expect(sessionReasoningFor("snps-provider/GLM-5.2", { thinking: false })).toEqual({ thinking: false })
	})
})

describe("context budget", () => {
	it("only ever lowers the model's own budget", () => {
		expect(tunedInputTokens(92_000, { maxInputTokens: 64_000 })).toBe(64_000)
		expect(tunedInputTokens(50_000, { maxInputTokens: 64_000 })).toBe(50_000)
		expect(tunedInputTokens(92_000, undefined)).toBe(92_000)
	})

	it("lowers the session model's entry without touching the catalog's", () => {
		const catalog: Record<string, { contextWindow: number; maxInputTokens?: number }> = {
			glm: { contextWindow: 512_000 },
			router: { contextWindow: 256_000, maxInputTokens: 92_000 },
		}
		const tuned = applyTunedInputBudget(catalog, "glm", { maxInputTokens: 64_000 })
		expect(tuned?.glm.maxInputTokens).toBe(64_000)
		expect(catalog.glm).toEqual({ contextWindow: 512_000 })
		expect(applyTunedInputBudget(catalog, "router", { maxInputTokens: 128_000 })?.router.maxInputTokens).toBe(92_000)
		expect(applyTunedInputBudget(catalog, "glm", { thinking: false })).toBe(catalog)
		expect(applyTunedInputBudget(catalog, "missing", { maxInputTokens: 64_000 })).toBe(catalog)
	})
})

describe("modelTuningOptions", () => {
	it("offers an off-switch only on a model that reasons by default and has a measured one", () => {
		const glm = { contextWindow: 512_000, thinkingControls: { defaultOn: true, off: "template-kwargs" } }
		expect(modelTuningOptions(glm, false)).toMatchObject({ canTurnOff: true, canTurnOn: false, effort: false })
	})

	it("offers on and effort on a model whose on-switch is reasoning_effort", () => {
		const gpt = { contextWindow: 272_000, thinkingControls: { defaultOn: false, on: "reasoning-effort" } }
		expect(modelTuningOptions(gpt, false)).toMatchObject({ canTurnOff: false, canTurnOn: true, effort: true })
	})

	it("offers no reasoning control on an unmeasured model or a router", () => {
		expect(modelTuningOptions({ contextWindow: 200_000 }, false)).toMatchObject({
			canTurnOff: false,
			canTurnOn: false,
			effort: false,
		})
		const router = { contextWindow: 256_000, maxInputTokens: 92_000, thinkingControls: { defaultOn: true, off: "x" } }
		expect(modelTuningOptions(router, true)).toMatchObject({ canTurnOff: false, effort: false })
	})

	it("offers only context presets below the model's own budget", () => {
		expect(modelTuningOptions({ contextWindow: 256_000, maxInputTokens: 92_000 }, true).contextPresets).toEqual([
			64_000, 32_000,
		])
		expect(modelTuningOptions({ contextWindow: 1_000_000 }, false).contextPresets).toEqual([128_000, 64_000, 32_000])
	})
})

describe("describeModelTuning", () => {
	it("names what is tuned", () => {
		expect(describeModelTuning({ effort: "high", maxInputTokens: 64_000 })).toBe("effort high, 64k context")
		expect(describeModelTuning({ thinking: false })).toBe("thinking off")
		expect(describeModelTuning(undefined)).toBe("")
	})
})
