import { beforeEach, describe, expect, it, vi } from "vitest"

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown>, section: "" }))

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: (section: string) => {
			settings.section = section
			return { get: (key: string) => settings.values[key] }
		},
	},
}))

import { getSubAgentLimits } from "./subagent-settings"

describe("getSubAgentLimits", () => {
	beforeEach(() => {
		settings.values = {}
	})

	it("reads plinycode.subagents and keeps the engine's defaults when nothing is set", () => {
		expect(getSubAgentLimits()).toEqual({ maxDepth: 1, maxConcurrent: 3, maxIterations: 40 })
		expect(settings.section).toBe("plinycode.subagents")
	})

	it("passes values in range through", () => {
		settings.values = { maxDepth: 2, maxConcurrent: 6, maxIterations: 120 }
		expect(getSubAgentLimits()).toEqual({ maxDepth: 2, maxConcurrent: 6, maxIterations: 120 })
	})

	it("clamps values out of range and ignores ones that are not numbers", () => {
		settings.values = { maxDepth: 5, maxConcurrent: 0, maxIterations: 1000.7 }
		expect(getSubAgentLimits()).toEqual({ maxDepth: 2, maxConcurrent: 1, maxIterations: 200 })
		settings.values = { maxDepth: "deep", maxConcurrent: null, maxIterations: 7.9 }
		expect(getSubAgentLimits()).toEqual({ maxDepth: 1, maxConcurrent: 3, maxIterations: 7 })
	})
})
