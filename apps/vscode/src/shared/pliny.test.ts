/**
 * The extension and webview keep their own copies of the FreeAuto constants so
 * they do not have to import the SDK catalog at those layers. These tests are
 * the guard that the copies never drift from the SDK's definition.
 */

import {
	PLINY_FREE_AUTO_FALLBACK_MODEL_ID as SDK_FALLBACK,
	PLINY_FREE_AUTO_MODEL_ID as SDK_FREE_AUTO,
	PLINY_DEFAULT_MODEL_ID as SDK_PLINY_DEFAULT_MODEL_ID,
	isPlinyFreeAutoModelId as sdkIsPlinyFreeAutoModelId,
	isPlinyFreeModelId as sdkIsPlinyFreeModelId,
	isPlinySelfHostedModelId as sdkIsPlinySelfHostedModelId,
	resolvePlinyConcreteModelId as sdkResolvePlinyConcreteModelId,
} from "@plinycode/llms"
import { describe, expect, it } from "vitest"
import {
	isPlinyFreeAutoModelId,
	isPlinyFreeModelId,
	isPlinySelfHostedModelId,
	PLINY_DEFAULT_MODEL_ID,
	PLINY_FEATURED_MODELS,
	PLINY_FREE_AUTO_FALLBACK_MODEL_ID,
	PLINY_FREE_AUTO_MODEL_ID,
	PLINY_FREE_AUTO_RULES_URI,
	resolvePlinyConcreteModelId,
} from "./pliny"

describe("Pliny constants match the SDK catalog", () => {
	it("uses the same router id", () => {
		expect(PLINY_FREE_AUTO_MODEL_ID).toBe(SDK_FREE_AUTO)
	})

	it("uses the same concrete fallback", () => {
		expect(PLINY_FREE_AUTO_FALLBACK_MODEL_ID).toBe(SDK_FALLBACK)
	})

	it("uses the same default model", () => {
		expect(PLINY_DEFAULT_MODEL_ID).toBe(SDK_PLINY_DEFAULT_MODEL_ID)
	})

	it("defaults to the router", () => {
		expect(PLINY_DEFAULT_MODEL_ID).toBe(PLINY_FREE_AUTO_MODEL_ID)
	})
})

describe("model id predicates agree with the SDK", () => {
	const ids = [
		"pliny/free-auto",
		"snps-provider/kimi-k2.6",
		"snps-provider-vmodels/glm-5.2",
		"snps-aws-bedrock/global.anthropic.claude-sonnet-5",
		"azure-openai/gpt-5.2",
	]

	it.each(ids)("classifies %s the same way", (id) => {
		expect(isPlinyFreeAutoModelId(id)).toBe(sdkIsPlinyFreeAutoModelId(id))
		expect(isPlinySelfHostedModelId(id)).toBe(sdkIsPlinySelfHostedModelId(id))
		expect(isPlinyFreeModelId(id)).toBe(sdkIsPlinyFreeModelId(id))
	})

	it("treats the router as free but not self-hosted", () => {
		expect(isPlinyFreeModelId(PLINY_FREE_AUTO_MODEL_ID)).toBe(true)
		expect(isPlinySelfHostedModelId(PLINY_FREE_AUTO_MODEL_ID)).toBe(false)
	})

	it("treats paid hosted models as not free", () => {
		expect(isPlinyFreeModelId("azure-openai/gpt-5.2")).toBe(false)
	})

	it("tolerates undefined", () => {
		expect(isPlinyFreeModelId(undefined)).toBe(false)
		expect(isPlinySelfHostedModelId(null)).toBe(false)
	})
})

describe("resolvePlinyConcreteModelId", () => {
	it("maps the router id to a concrete model, like the SDK", () => {
		expect(resolvePlinyConcreteModelId(PLINY_FREE_AUTO_MODEL_ID)).toBe(sdkResolvePlinyConcreteModelId(SDK_FREE_AUTO))
		expect(resolvePlinyConcreteModelId(PLINY_FREE_AUTO_MODEL_ID)).not.toBe(PLINY_FREE_AUTO_MODEL_ID)
	})

	it("leaves a concrete model untouched", () => {
		expect(resolvePlinyConcreteModelId("snps-provider/GLM-5.2")).toBe("snps-provider/GLM-5.2")
	})

	it("falls back when no model is given", () => {
		expect(resolvePlinyConcreteModelId(undefined)).toBe(PLINY_FREE_AUTO_FALLBACK_MODEL_ID)
	})
})

describe("featured models", () => {
	it("lists the router first and marks it as the default", () => {
		expect(PLINY_FEATURED_MODELS[0].id).toBe(PLINY_FREE_AUTO_MODEL_ID)
		expect(PLINY_FEATURED_MODELS[0].tags as readonly string[]).toContain("DEFAULT")
	})

	it("marks exactly one model as the default", () => {
		const defaults = PLINY_FEATURED_MODELS.filter((model) => (model.tags as readonly string[]).includes("DEFAULT"))
		expect(defaults).toHaveLength(1)
	})
})

describe("FreeAuto rules URI", () => {
	it("is a distinct scheme, so it cannot collide with a real file path", () => {
		expect(PLINY_FREE_AUTO_RULES_URI.startsWith("pliny://")).toBe(true)
	})

	it("is not mistaken for a model id", () => {
		expect(isPlinyFreeAutoModelId(PLINY_FREE_AUTO_RULES_URI)).toBe(false)
		expect(isPlinyFreeModelId(PLINY_FREE_AUTO_RULES_URI)).toBe(false)
	})
})
