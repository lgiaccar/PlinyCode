import { EmptyRequest } from "@shared/proto/cline/common"
import { SetRouterTuningRequest } from "@shared/proto/cline/models"
import type { RouterSettingsView, RouterTuningMap } from "@shared/router-tuning"
import { describe, expect, it, vi } from "vitest"
import { getRouterSettings } from "../getRouterSettings"
import type { RouterSettingsController } from "../router-settings-view"
import { setRouterTuning } from "../setRouterTuning"

vi.mock("@/sdk/router/router-rules-store", async () => {
	const { defaultRules } = await import("@/sdk/router/router-rules")
	return { loadRouterRules: vi.fn(async (options?: { profile?: string }) => defaultRules(options?.profile)) }
})

const GLM = "snps-provider/GLM-5.2"
const KIMI = "snps-provider/kimi-k2.6"

function makeController(stored: RouterTuningMap) {
	let state = stored
	const controller = {
		stateManager: {
			getGlobalStateKey: vi.fn(() => state),
			reloadGlobalStateKey: vi.fn(() => state),
			setGlobalState: vi.fn((_key: string, value: RouterTuningMap) => {
				state = value
			}),
		},
		getWorkspaceRoot: vi.fn(async () => "/workspace"),
	}
	return { controller: controller as unknown as RouterSettingsController, state: () => state }
}

function parse(json: string): RouterSettingsView {
	return JSON.parse(json) as RouterSettingsView
}

describe("getRouterSettings", () => {
	it("lists the four routers with their defaults and the models each may use", async () => {
		const { controller } = makeController({})
		const view = parse((await getRouterSettings(controller, EmptyRequest.create({}))).settingsJson)
		expect(view.profiles.map((profile) => profile.profile).sort()).toEqual(["balance", "default", "fast", "smart"])

		const free = view.profiles.find((profile) => profile.profile === "default")
		expect(free?.base.models[0]).toBe(KIMI)
		expect(free?.candidates.some((candidate) => candidate.id === GLM && candidate.free)).toBe(true)
		expect(free?.candidates.every((candidate) => candidate.free)).toBe(true)

		const balance = view.profiles.find((profile) => profile.profile === "balance")
		expect(balance?.candidates.some((candidate) => !candidate.free)).toBe(true)
	})
})

describe("setRouterTuning", () => {
	it("stores one profile's tuning next to the others' and returns the new view", async () => {
		const { controller, state } = makeController({ fast: { sticky: false } })
		const response = await setRouterTuning(
			controller,
			SetRouterTuningRequest.create({ profile: "default", tuningJson: JSON.stringify({ models: [GLM, KIMI], bogus: 1 }) }),
		)
		expect(state()).toEqual({ fast: { sticky: false }, default: { models: [GLM, KIMI] } })
		const view = parse(response.settingsJson)
		expect(view.profiles.find((profile) => profile.profile === "default")?.tuning).toEqual({ models: [GLM, KIMI] })
	})

	it("clears the profile's entry on an empty tuning", async () => {
		const { controller, state } = makeController({ default: { models: [GLM] }, fast: { sticky: false } })
		await setRouterTuning(controller, SetRouterTuningRequest.create({ profile: "default", tuningJson: "{}" }))
		expect(state()).toEqual({ fast: { sticky: false } })
	})

	it("rejects an unknown profile and invalid JSON", async () => {
		const { controller } = makeController({})
		await expect(
			setRouterTuning(controller, SetRouterTuningRequest.create({ profile: "turbo", tuningJson: "{}" })),
		).rejects.toThrow("Unknown router profile")
		await expect(
			setRouterTuning(controller, SetRouterTuningRequest.create({ profile: "default", tuningJson: "{" })),
		).rejects.toThrow("not valid JSON")
	})
})
