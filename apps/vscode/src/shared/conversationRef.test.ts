import { describe, expect, it } from "vitest"
import { conversationRef } from "./conversationRef"

describe("conversationRef", () => {
	it("uses the random part of a conversation id", () => {
		expect(conversationRef("1760000000000_ab3dx")).toBe("ab3dx")
	})

	it("falls back to the last 6 characters of an id without one", () => {
		expect(conversationRef("1760000000123")).toBe("000123")
	})

	it("is lower case and free of punctuation", () => {
		expect(conversationRef("1760000000000_AB-3DX")).toBe("ab3dx")
	})
})
