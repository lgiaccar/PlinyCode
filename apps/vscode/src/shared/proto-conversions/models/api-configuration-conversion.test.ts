import { describe, expect, it } from "vitest"
import { convertApiConfigurationToProto, convertProtoToApiConfiguration } from "./api-configuration-conversion"

describe("api configuration provider conversion", () => {
	it("round-trips the Pliny provider", () => {
		const proto = convertApiConfigurationToProto({
			actModeApiProvider: "pliny",
			planModeApiProvider: "pliny",
			actModeApiModelId: "pliny/auto-free",
		})

		// Assert field-by-field instead of toMatchObject: this file is also picked up by
		// the mocha integration runner (.vscode-test.mjs globs src/shared/**/*.test.js),
		// where vitest's jest-compat matchers like toMatchObject are not available.
		const result = convertProtoToApiConfiguration(proto)
		expect(result.actModeApiProvider).toBe("pliny")
		expect(result.planModeApiProvider).toBe("pliny")
		expect(result.actModeApiModelId).toBe("pliny/auto-free")
	})

	it("reads a provider id from an older version as pliny", () => {
		const result = convertProtoToApiConfiguration({
			actModeApiProvider: "anthropic",
			planModeApiProvider: "openrouter",
		} as Parameters<typeof convertProtoToApiConfiguration>[0])

		expect(result.actModeApiProvider).toBe("pliny")
		expect(result.planModeApiProvider).toBe("pliny")
	})
})
