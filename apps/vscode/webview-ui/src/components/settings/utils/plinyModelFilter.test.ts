import { openAiModelInfoSafeDefaults } from "@shared/api"
import { describe, expect, it } from "vitest"
import {
	filterPlinyModels,
	isPlinyBalanceAutoModelId,
	isPlinyFreeAutoModelId,
	isPlinyFreeModelId,
	isPlinyPaidModel,
	isPlinySelfHostedModelId,
	PLINY_BALANCE_AUTO_MODEL_ID,
	PLINY_FREE_AUTO_MODEL_ID,
	PLINY_FREE_DEFAULT_MODEL_ID,
} from "./plinyModelFilter"

function info(id: string) {
	return { ...openAiModelInfoSafeDefaults, id, name: id }
}

const SAMPLE = {
	[PLINY_FREE_AUTO_MODEL_ID]: info(PLINY_FREE_AUTO_MODEL_ID),
	[PLINY_BALANCE_AUTO_MODEL_ID]: info(PLINY_BALANCE_AUTO_MODEL_ID),
	"snps-provider/GLM-5.2": info("snps-provider/GLM-5.2"),
	"snps-provider/qwen3.5-397b-fp8": info("snps-provider/qwen3.5-397b-fp8"),
	"snps-provider-vmodels/glm-5.2": info("snps-provider-vmodels/glm-5.2"),
	"snps-provider-sia/qwen3-8-27b-sia": info("snps-provider-sia/qwen3-8-27b-sia"),
	"snps-aws-bedrock/aws-claude-sonnet-4.6": info("snps-aws-bedrock/aws-claude-sonnet-4.6"),
	"azure-openai/gpt-5.2": info("azure-openai/gpt-5.2"),
	"snps-google-gcp/gemini-3.7-flash": info("snps-google-gcp/gemini-3.7-flash"),
	"google-vertex/glm-5.2": info("google-vertex/glm-5.2"),
}

describe("isPlinySelfHostedModelId / isPlinyPaidModel", () => {
	it("treats snps-provider* ids as free self-hosted", () => {
		expect(isPlinySelfHostedModelId("snps-provider/GLM-5.2")).toBe(true)
		expect(isPlinySelfHostedModelId("snps-provider-vmodels/glm-5.2")).toBe(true)
		expect(isPlinySelfHostedModelId("snps-provider-sia/qwen3-8-27b-sia")).toBe(true)
		expect(isPlinySelfHostedModelId("snps-provider-internal-tests/glm-5-2")).toBe(true)
	})

	it("treats hosted pools as paid (not snps-provider)", () => {
		expect(isPlinyPaidModel("snps-aws-bedrock/aws-claude-sonnet-4.6")).toBe(true)
		expect(isPlinyPaidModel("azure-openai/gpt-5.2")).toBe(true)
		expect(isPlinyPaidModel("snps-google-gcp/gemini-3.7-flash")).toBe(true)
		expect(isPlinyPaidModel("google-vertex/glm-5.2")).toBe(true)
		// snps-aws-bedrock / snps-google-gcp must NOT match the snps-provider prefix
		expect(isPlinySelfHostedModelId("snps-aws-bedrock/aws-claude-sonnet-4.6")).toBe(false)
		expect(isPlinySelfHostedModelId("snps-google-gcp/gemini-3.7-flash")).toBe(false)
	})
})

describe("filterPlinyModels", () => {
	it("returns the full catalog unchanged when both paid and free models are unlocked", () => {
		const result = filterPlinyModels(SAMPLE, "snps-aws-bedrock/aws-claude-sonnet-4.6", true, true)
		expect(Object.keys(result.models).length).toBe(10)
		expect(result.defaultModelId).toBe("snps-aws-bedrock/aws-claude-sonnet-4.6")
	})

	it("keeps only the FreeAuto router by default when both toggles are locked", () => {
		const result = filterPlinyModels(SAMPLE, "snps-aws-bedrock/aws-claude-sonnet-4.6", false, false)
		expect(Object.keys(result.models)).toEqual([PLINY_FREE_AUTO_MODEL_ID])
		expect(result.defaultModelId).toBe(PLINY_FREE_DEFAULT_MODEL_ID)
	})

	it("keeps free self-hosted models plus FreeAuto when only free is unlocked", () => {
		const result = filterPlinyModels(SAMPLE, "snps-aws-bedrock/aws-claude-sonnet-4.6", false, true)
		expect(Object.keys(result.models).sort()).toEqual(
			[
				PLINY_FREE_AUTO_MODEL_ID,
				"snps-provider-sia/qwen3-8-27b-sia",
				"snps-provider-vmodels/glm-5.2",
				"snps-provider/GLM-5.2",
				"snps-provider/qwen3.5-397b-fp8",
			].sort(),
		)
		expect(result.defaultModelId).toBe(PLINY_FREE_DEFAULT_MODEL_ID)
	})

	it("keeps paid models, BalanceAuto and FreeAuto when only paid is unlocked", () => {
		const result = filterPlinyModels(SAMPLE, PLINY_FREE_AUTO_MODEL_ID, true, false)
		expect(Object.keys(result.models).sort()).toEqual(
			[
				PLINY_FREE_AUTO_MODEL_ID,
				PLINY_BALANCE_AUTO_MODEL_ID,
				"snps-aws-bedrock/aws-claude-sonnet-4.6",
				"azure-openai/gpt-5.2",
				"snps-google-gcp/gemini-3.7-flash",
				"google-vertex/glm-5.2",
			].sort(),
		)
		expect(result.defaultModelId).toBe(PLINY_FREE_AUTO_MODEL_ID)
	})

	it("preserves a free default as-is when its class is unlocked", () => {
		const result = filterPlinyModels(SAMPLE, "snps-provider/GLM-5.2", false, true)
		expect(result.defaultModelId).toBe("snps-provider/GLM-5.2")
		expect(result.models["snps-provider/GLM-5.2"]).toBeDefined()
	})

	it("redirects the default to FreeAuto when the committed default's class is locked", () => {
		const result = filterPlinyModels(SAMPLE, "snps-provider/GLM-5.2", false, false)
		expect(result.defaultModelId).toBe(PLINY_FREE_DEFAULT_MODEL_ID)
	})

	it("falls back to the first visible model when FreeAuto itself is absent", () => {
		const onlyOther = {
			"snps-provider/kimi-k2.6": info("snps-provider/kimi-k2.6"),
		}
		const result = filterPlinyModels(onlyOther, "snps-aws-bedrock/aws-claude-sonnet-4.6", false, true)
		expect(result.defaultModelId).toBe("snps-provider/kimi-k2.6")
	})

	it("returns an empty model set with empty default when nothing is visible", () => {
		const paidOnly = { "azure-openai/gpt-5.2": info("azure-openai/gpt-5.2") }
		const result = filterPlinyModels(paidOnly, "azure-openai/gpt-5.2", false, false)
		expect(Object.keys(result.models)).toHaveLength(0)
		expect(result.defaultModelId).toBe("")
	})
})

describe("FreeAuto router in the picker", () => {
	it("is treated as free, so it stays visible when both paid and free classes are locked", () => {
		expect(isPlinyFreeModelId(PLINY_FREE_AUTO_MODEL_ID)).toBe(true)
		expect(isPlinyPaidModel(PLINY_FREE_AUTO_MODEL_ID)).toBe(false)
		const result = filterPlinyModels(SAMPLE, PLINY_FREE_AUTO_MODEL_ID, false, false)
		expect(Object.keys(result.models)).toContain(PLINY_FREE_AUTO_MODEL_ID)
	})

	it("is the default the picker falls back to", () => {
		expect(PLINY_FREE_DEFAULT_MODEL_ID).toBe(PLINY_FREE_AUTO_MODEL_ID)
	})

	it("is kept as the committed selection when locked", () => {
		const result = filterPlinyModels(SAMPLE, PLINY_FREE_AUTO_MODEL_ID, false, false)
		expect(result.defaultModelId).toBe(PLINY_FREE_AUTO_MODEL_ID)
	})

	it("is not itself a self-hosted endpoint", () => {
		expect(isPlinySelfHostedModelId(PLINY_FREE_AUTO_MODEL_ID)).toBe(false)
	})
})

describe("BalanceAuto router in the picker", () => {
	it("counts as paid, not free, and is not a FreeAuto profile", () => {
		expect(isPlinyBalanceAutoModelId(PLINY_BALANCE_AUTO_MODEL_ID)).toBe(true)
		expect(isPlinyPaidModel(PLINY_BALANCE_AUTO_MODEL_ID)).toBe(true)
		expect(isPlinyFreeModelId(PLINY_BALANCE_AUTO_MODEL_ID)).toBe(false)
		expect(isPlinyFreeAutoModelId(PLINY_BALANCE_AUTO_MODEL_ID)).toBe(false)
		expect(isPlinySelfHostedModelId(PLINY_BALANCE_AUTO_MODEL_ID)).toBe(false)
	})

	it("is hidden while paid models are locked, even with free models unlocked", () => {
		expect(Object.keys(filterPlinyModels(SAMPLE, PLINY_FREE_AUTO_MODEL_ID, false, false).models)).not.toContain(
			PLINY_BALANCE_AUTO_MODEL_ID,
		)
		expect(Object.keys(filterPlinyModels(SAMPLE, PLINY_FREE_AUTO_MODEL_ID, false, true).models)).not.toContain(
			PLINY_BALANCE_AUTO_MODEL_ID,
		)
	})

	it("is shown as soon as paid models are unlocked", () => {
		expect(Object.keys(filterPlinyModels(SAMPLE, PLINY_FREE_AUTO_MODEL_ID, true, false).models)).toContain(
			PLINY_BALANCE_AUTO_MODEL_ID,
		)
	})

	it("is kept as a committed default only while paid models are unlocked", () => {
		expect(filterPlinyModels(SAMPLE, PLINY_BALANCE_AUTO_MODEL_ID, true, false).defaultModelId).toBe(
			PLINY_BALANCE_AUTO_MODEL_ID,
		)
		expect(filterPlinyModels(SAMPLE, PLINY_BALANCE_AUTO_MODEL_ID, false, true).defaultModelId).toBe(
			PLINY_FREE_DEFAULT_MODEL_ID,
		)
	})
})
