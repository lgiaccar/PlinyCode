import { act, renderHook } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it } from "vitest"
import { isLongPrompt, wordCount } from "../../compactPrompt"
import { useCompactPaste } from "./useCompactPaste"

const pasted = "word\t".repeat(350)
function setup(initial = "") {
	return renderHook(() => {
		const [full, setFull] = useState(initial)
		return { full, setFull, ...useCompactPaste(full, setFull) }
	})
}

describe("compact pasted prompts", () => {
	it("preserves selection replacement and surrounding text while displaying only a word count", () => {
		const { result } = setup("before replace after")
		act(() => {
			result.current.paste(pasted, 7, 14)
		})
		expect(result.current.full).toBe(`before ${pasted} after`)
		expect(result.current.value).toBe("before [Pasted text #1: 350 words] after")
		act(() => result.current.setValue(`${result.current.value}!`))
		expect(result.current.full).toBe(`before ${pasted} after!`)
	})
	it("keeps multiple pastes in order and expands them without changing the real draft", () => {
		const { result } = setup()
		act(() => {
			result.current.paste(pasted, 0, 0)
		})
		act(() => {
			result.current.paste("second\n".repeat(40), result.current.value.length, result.current.value.length)
		})
		expect(result.current.blocks).toHaveLength(2)
		expect(result.current.full).toBe(pasted + "second\n".repeat(40))
		act(() => result.current.expand())
		expect(result.current.value).toBe(result.current.full)
		expect(result.current.blocks).toHaveLength(0)
	})
	it("deletes a collapsed block as a unit and clears it when the parent replaces the draft", () => {
		const { result } = setup()
		act(() => {
			result.current.paste(pasted, 0, 0)
		})
		act(() => result.current.setValue(result.current.value.slice(0, -1)))
		expect(result.current.full).toBe("")
		act(() => {
			result.current.paste(pasted, 0, 0)
		})
		act(() => result.current.setFull("A recalled prompt"))
		expect(result.current.value).toBe("A recalled prompt")
		expect(result.current.blocks).toHaveLength(0)
	})
	it("does not compact short text and handles long lines and multilingual whitespace", () => {
		const { result } = setup()
		act(() => {
			expect(result.current.paste("short", 0, 0)).toBeUndefined()
		})
		expect(isLongPrompt("a".repeat(2000))).toBe(true)
		expect(isLongPrompt("line\n".repeat(30))).toBe(true)
		expect(wordCount("  one\t二\r\nthree  ")).toBe(3)
		expect(wordCount(" \n")).toBe(0)
	})

	it("copies complete content and restores a deleted block on native undo", () => {
		const { result } = setup()
		act(() => {
			result.current.paste(pasted, 0, 0)
		})
		const display = result.current.value
		expect(result.current.copy(0, display.length)).toBe(pasted)
		act(() => result.current.setValue(""))
		act(() => result.current.setValue(display))
		expect(result.current.full).toBe(pasted)
		expect(result.current.copy(1, display.length - 1)).toBe(pasted)
		act(() => {
			result.current.cut(1, display.length - 1)
		})
		expect(result.current.full).toBe("")
	})
})
