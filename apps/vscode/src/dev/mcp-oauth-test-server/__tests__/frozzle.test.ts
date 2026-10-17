import { describe, expect, it } from "bun:test"
import { frozzle } from "../server"

// The `frozzle` tool's value is that its output can't be guessed without
// calling it; these tests pin the exact transform so evals and the server stay
// in sync. If you change frozzle(), update any eval fixtures that assert on it.
describe("frozzle", () => {
	it("reverses the string, swaps case, and wraps in guillemets", () => {
		expect(frozzle("Hello")).toBe("«OLLEh»")
	})

	it("leaves digits and spaces in place (only letter case is swapped)", () => {
		expect(frozzle("Frozzle Me 123")).toBe("«321 Em ELZZORf»")
	})

	it("handles empty input", () => {
		expect(frozzle("")).toBe("«»")
	})

	it("swaps each letter's case independently", () => {
		expect(frozzle("MixedCase")).toBe("«ESAcDEXIm»")
	})

	it("is invertible: re-frozzling the inner content restores the original", () => {
		// frozzle = reverse + swapCase, both self-inverse, so applying the same
		// transform to the unwrapped result returns the original input.
		const original = "AbCdef 99"
		const inner = frozzle(original).slice(1, -1) // strip « »
		expect(frozzle(inner)).toBe(`«${original}»`)
	})
})
