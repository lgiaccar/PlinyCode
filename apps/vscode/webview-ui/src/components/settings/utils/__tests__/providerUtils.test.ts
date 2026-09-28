import type { ApiConfiguration } from "@shared/api"
import { describe, expect, it, vi } from "vitest"
import { getModeSpecificFields, syncModeConfigurations } from "../providerUtils"

describe("getModeSpecificFields", () => {
	it("returns undefined fields when apiConfiguration is undefined", () => {
		const fields = getModeSpecificFields(undefined, "plan")
		expect(fields.apiProvider).toBeUndefined()
		expect(fields.apiModelId).toBeUndefined()
	})

	it("reads the mode's provider and model", () => {
		const apiConfiguration: ApiConfiguration = {
			planModeApiProvider: "pliny",
			planModeApiModelId: "snps-provider/GLM-5.2",
			actModeApiProvider: "pliny",
			actModeApiModelId: "pliny/auto-free",
		}

		expect(getModeSpecificFields(apiConfiguration, "plan")).toMatchObject({
			apiProvider: "pliny",
			apiModelId: "snps-provider/GLM-5.2",
		})
		expect(getModeSpecificFields(apiConfiguration, "act").apiModelId).toBe("pliny/auto-free")
	})

	it("reads a provider stored by an older version as pliny", () => {
		const apiConfiguration = { planModeApiProvider: "openrouter" } as unknown as ApiConfiguration

		expect(getModeSpecificFields(apiConfiguration, "plan").apiProvider).toBe("pliny")
	})
})

describe("syncModeConfigurations", () => {
	it("copies the source mode's model to both modes", async () => {
		const handleFieldsChange = vi.fn(async (_updates: Partial<ApiConfiguration>) => {})

		await syncModeConfigurations(
			{ planModeApiProvider: "pliny", planModeApiModelId: "snps-provider/GLM-5.2", planModeReasoningEffort: "high" },
			"plan",
			handleFieldsChange,
		)

		expect(handleFieldsChange).toHaveBeenCalledWith(
			expect.objectContaining({
				planModeApiProvider: "pliny",
				actModeApiProvider: "pliny",
				planModeApiModelId: "snps-provider/GLM-5.2",
				actModeApiModelId: "snps-provider/GLM-5.2",
				planModeReasoningEffort: "high",
				actModeReasoningEffort: "high",
			}),
		)
	})
})
