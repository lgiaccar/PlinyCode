import { renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { fittingRows, rowsFromDrag, useFittingRows, useResizableRows } from "./useResizableRows"

vi.mock("@/components/settings/utils/settingsHandlers", () => ({ updateSetting: vi.fn() }))

describe("fittingRows", () => {
	const base = { viewportPx: 800, footerPx: 400, textAreaPx: 200, textAreaChromePx: 20, rowHeightPx: 20 }

	it("gives the prompt box what the conversation's minimum and the rest of the footer leave", () => {
		// 800 - 200 (conversation) - 200 (footer around the textarea) - 20 (padding) = 380px = 19 rows
		expect(fittingRows(base)).toBe(19)
	})

	it("shrinks when the panel shrinks or the footer grows around the textarea", () => {
		expect(fittingRows({ ...base, viewportPx: 600 })).toBeLessThan(19)
		expect(fittingRows({ ...base, footerPx: 500 })).toBe(14)
	})

	it("leaves the conversation a quarter of the panel, at least 120px and at most half", () => {
		const roomFor = (viewportPx: number) =>
			fittingRows({ ...base, viewportPx, footerPx: 0, textAreaPx: 0, textAreaChromePx: 0, rowHeightPx: 1 })
		expect(roomFor(800)).toBe(600)
		expect(roomFor(400)).toBe(280)
		expect(roomFor(200)).toBe(100)
	})

	it("never goes below one row", () => {
		expect(fittingRows({ ...base, viewportPx: 150 })).toBe(1)
	})
})

describe("rowsFromDrag", () => {
	it("stops at the rows that fit", () => {
		expect(rowsFromDrag(10, -1000, 18, 15)).toBe(15)
		expect(rowsFromDrag(10, -1000, 18, 60)).toBe(40)
	})
})

describe("useResizableRows", () => {
	const ref = { current: null }

	it("shows no more rows than fit, and keeps the user's own setting", () => {
		const { result, rerender } = renderHook(({ fit }) => useResizableRows(30, ref, fit), {
			initialProps: { fit: 12 as number | undefined },
		})
		expect(result.current.maxRows).toBe(30)
		expect(result.current.shownMaxRows).toBe(12)
		expect(result.current.upperRows).toBe(12)
		rerender({ fit: undefined })
		expect(result.current.shownMaxRows).toBe(30)
		expect(result.current.upperRows).toBe(40)
	})
})

describe("useFittingRows", () => {
	it("measures the textarea against the footer and the window", () => {
		const footer = document.createElement("footer")
		const textArea = document.createElement("textarea")
		textArea.style.lineHeight = "20px"
		textArea.style.padding = "10px 0"
		textArea.style.border = "0"
		footer.appendChild(textArea)
		document.body.appendChild(footer)
		vi.spyOn(footer, "getBoundingClientRect").mockReturnValue({ height: 400 } as DOMRect)
		vi.spyOn(textArea, "getBoundingClientRect").mockReturnValue({ height: 200 } as DOMRect)
		const innerHeight = window.innerHeight
		window.innerHeight = 800
		try {
			const { result } = renderHook(() => useFittingRows({ current: textArea }))
			expect(result.current).toBe(19)
		} finally {
			window.innerHeight = innerHeight
			document.body.removeChild(footer)
		}
	})

	it("does not cap a textarea that is not laid out", () => {
		const footer = document.createElement("footer")
		const textArea = document.createElement("textarea")
		footer.appendChild(textArea)
		document.body.appendChild(footer)
		const { result } = renderHook(() => useFittingRows({ current: textArea }))
		expect(result.current).toBeUndefined()
		document.body.removeChild(footer)
	})
})
