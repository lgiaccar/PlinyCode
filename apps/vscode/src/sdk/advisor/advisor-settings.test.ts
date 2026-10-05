import { describe, expect, it } from "vitest"
import { PLINY_BALANCE_AUTO_MODEL_ID, PLINY_FREE_AUTO_MODEL_ID } from "@/shared/pliny"
import packageJson from "../../../package.json"
import { defaultRules } from "../router/router-rules"
import {
	type AdvisorSettings,
	advisorUnavailableReason,
	DEFAULT_ADVISOR_SETTINGS,
	normalizeAdvisorSettings,
} from "./advisor-settings"

const SONNET_5 = DEFAULT_ADVISOR_SETTINGS.model

const settings = (overrides: Partial<AdvisorSettings> = {}): AdvisorSettings => ({ ...DEFAULT_ADVISOR_SETTINGS, ...overrides })
const offered = (overrides: Partial<AdvisorSettings>, modelId: string | undefined) =>
	advisorUnavailableReason(settings(overrides), modelId) === undefined

describe("advisor settings", () => {
	it("defaults to the model that leads BalanceAuto's default route", () => {
		const defaultRoute = defaultRules("balance").routes.find((route) => route.name === "default")
		expect(SONNET_5).toBe(defaultRoute?.use[0])
	})

	it("declares the same defaults in package.json as the code falls back to", () => {
		const properties = packageJson.contributes.configuration.properties
		expect(properties["plinycode.advisor.use"].default).toBe(DEFAULT_ADVISOR_SETTINGS.use)
		expect(properties["plinycode.advisor.use"].enum).toEqual(["balance", "always", "never"])
		for (const use of properties["plinycode.advisor.use"].enum) {
			expect(normalizeAdvisorSettings({ use }).use).toBe(use)
		}
		expect(properties["plinycode.advisor.model"].default).toBe(DEFAULT_ADVISOR_SETTINGS.model)
		expect(properties["plinycode.advisor.maxCallsPerConversation"].default).toBe(
			DEFAULT_ADVISOR_SETTINGS.maxCallsPerConversation,
		)
		// The setting that can spend money on a free conversation has to say so.
		expect(properties["plinycode.advisor.use"].markdownEnumDescriptions[1]).toContain("spends money")
	})

	it("falls back to the defaults for anything unusable", () => {
		expect(normalizeAdvisorSettings({})).toEqual(DEFAULT_ADVISOR_SETTINGS)
		expect(normalizeAdvisorSettings({ use: "sometimes", model: "  ", maxCallsPerConversation: -1 })).toEqual(
			DEFAULT_ADVISOR_SETTINGS,
		)
		expect(normalizeAdvisorSettings({ maxCallsPerConversation: Number.NaN }).maxCallsPerConversation).toBe(5)
	})

	it("keeps valid values, whole and bounded", () => {
		expect(
			normalizeAdvisorSettings({ use: "always", model: " azure-openai/gpt-5.2 ", maxCallsPerConversation: 2.9 }),
		).toEqual({
			use: "always",
			model: "azure-openai/gpt-5.2",
			maxCallsPerConversation: 2,
		})
		expect(normalizeAdvisorSettings({ maxCallsPerConversation: 0 }).maxCallsPerConversation).toBe(0)
		expect(normalizeAdvisorSettings({ maxCallsPerConversation: 10_000 }).maxCallsPerConversation).toBe(50)
	})
})

describe("advisorUnavailableReason", () => {
	it("offers the advisor only on BalanceAuto by default", () => {
		expect(offered({}, PLINY_BALANCE_AUTO_MODEL_ID)).toBe(true)
		// The id from before the auto-* rename is still BalanceAuto.
		expect(offered({}, "pliny/balance-auto")).toBe(true)
		expect(offered({}, PLINY_FREE_AUTO_MODEL_ID)).toBe(false)
		expect(offered({}, `${PLINY_FREE_AUTO_MODEL_ID}-smart`)).toBe(false)
		expect(offered({}, "snps-provider/kimi-k2.6")).toBe(false)
		expect(offered({}, "azure-openai/gpt-5.2")).toBe(false)
		expect(offered({}, undefined)).toBe(false)
	})

	it("offers it everywhere but on the advisor model itself when set to always", () => {
		expect(offered({ use: "always" }, PLINY_FREE_AUTO_MODEL_ID)).toBe(true)
		expect(offered({ use: "always" }, "snps-provider/kimi-k2.6")).toBe(true)
		expect(offered({ use: "always" }, "azure-openai/gpt-5.2")).toBe(true)
		expect(offered({ use: "always" }, PLINY_BALANCE_AUTO_MODEL_ID)).toBe(true)
		expect(offered({ use: "always" }, SONNET_5)).toBe(false)
		expect(offered({ use: "always", model: "azure-openai/gpt-5.2" }, "azure-openai/gpt-5.2")).toBe(false)
	})

	it("never offers it when turned off", () => {
		expect(offered({ use: "never" }, PLINY_BALANCE_AUTO_MODEL_ID)).toBe(false)
		expect(offered({ use: "never" }, PLINY_FREE_AUTO_MODEL_ID)).toBe(false)
	})

	it("does not accept a router as the advisor", () => {
		expect(advisorUnavailableReason(settings({ model: PLINY_FREE_AUTO_MODEL_ID }), PLINY_BALANCE_AUTO_MODEL_ID)).toContain(
			"concrete model",
		)
	})
})
