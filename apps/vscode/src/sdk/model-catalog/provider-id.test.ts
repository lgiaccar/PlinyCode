import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Logger } from "../../shared/services/Logger"
import { parseProviderId } from "./provider-id"

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	warnSpy = vi.spyOn(Logger, "warn").mockImplementation(() => {})
})

afterEach(() => {
	warnSpy.mockRestore()
})

describe("parseProviderId", () => {
	it("trims whitespace and lowercases the provider id", () => {
		expect(parseProviderId("  Anthropic  ")).toBe("anthropic")
		expect(parseProviderId("\tOPENROUTER\n")).toBe("openrouter")
	})

	it("accepts arbitrary custom provider ids", () => {
		expect(parseProviderId("  Custom-SDK-Provider  ")).toBe("custom-sdk-provider")
	})

	it("warns once per non-empty unknown provider id", () => {
		parseProviderId("provider-id-test-unknown-a")
		parseProviderId("provider-id-test-unknown-a")
		parseProviderId("provider-id-test-unknown-b")
		parseProviderId("   ")

		const warnings = warnSpy.mock.calls.filter((call: unknown[]) => {
			const message = call[0]
			return typeof message === "string" && message.includes("provider-id-test-unknown-")
		})
		expect(warnings).toHaveLength(2)
	})

	it("does not warn for known provider ids", () => {
		parseProviderId("pliny")
		parseProviderId("  Pliny ")

		expect(warnSpy).not.toHaveBeenCalled()
	})
})
