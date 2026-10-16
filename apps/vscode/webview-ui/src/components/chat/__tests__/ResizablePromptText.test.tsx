import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: { editMessageAndRegenerate: vi.fn() },
	CheckpointsServiceClient: { checkpointLatestChangesSummary: vi.fn() },
}))

// Heights are remembered per message ts for the whole module, so every test uses its own ts.
import ResizablePromptText, { MIN_PROMPT_HEIGHT } from "../ResizablePromptText"
import UserMessage from "../UserMessage"

// jsdom does no layout: give every element the size of a long prompt cut to
// its default height, so the text overflows.
const CONTENT_HEIGHT = 600
const SHOWN_HEIGHT = 240

function stubLayout(contentHeight: number, shownHeight: number) {
	const spies = [
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(contentHeight),
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
			const height = Number.parseFloat(this.style.height)
			return Number.isNaN(height) ? shownHeight : height
		}),
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			const height = Number.parseFloat(this.style.height)
			return { height: Number.isNaN(height) ? shownHeight : height } as DOMRect
		}),
	]
	return () => {
		for (const spy of spies) {
			spy.mockRestore()
		}
	}
}

describe("ResizablePromptText", () => {
	let restoreLayout: (() => void) | undefined

	beforeEach(() => {
		// jsdom has no PointerEvent; without one the events lose clientY and button.
		if (typeof window.PointerEvent === "undefined") {
			class PointerEventPolyfill extends MouseEvent {
				pointerId: number
				constructor(type: string, init: PointerEventInit = {}) {
					super(type, init)
					this.pointerId = init.pointerId ?? 0
				}
			}
			vi.stubGlobal("PointerEvent", PointerEventPolyfill)
		}
		vi.stubGlobal(
			"ResizeObserver",
			class ResizeObserver {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
	})

	afterEach(() => {
		restoreLayout?.()
		restoreLayout = undefined
	})

	it("shows no grip when the whole prompt fits", () => {
		restoreLayout = stubLayout(100, 100)
		render(
			<ResizablePromptText defaultMaxHeight={SHOWN_HEIGHT} messageTs={1}>
				Short prompt
			</ResizablePromptText>,
		)
		expect(screen.queryByTestId("prompt-resize-grip")).not.toBeInTheDocument()
		expect(screen.getByTestId("prompt-text-scroll").style.maxHeight).toBe(`${SHOWN_HEIGHT}px`)
	})

	it("drags a long prompt taller and shorter, within the text and the minimum", () => {
		restoreLayout = stubLayout(CONTENT_HEIGHT, SHOWN_HEIGHT)
		render(
			<ResizablePromptText defaultMaxHeight={SHOWN_HEIGHT} messageTs={2}>
				Long prompt
			</ResizablePromptText>,
		)
		const grip = screen.getByTestId("prompt-resize-grip")
		const box = screen.getByTestId("prompt-text-scroll")

		fireEvent.pointerDown(grip, { button: 0, clientY: 100, pointerId: 1 })
		fireEvent.pointerMove(grip, { clientY: 200, pointerId: 1 })
		expect(box.style.height).toBe(`${SHOWN_HEIGHT + 100}px`)
		expect(box.style.maxHeight).toBe("")

		fireEvent.pointerMove(grip, { clientY: 2000, pointerId: 1 })
		expect(box.style.height).toBe(`${CONTENT_HEIGHT}px`)

		fireEvent.pointerMove(grip, { clientY: -2000, pointerId: 1 })
		expect(box.style.height).toBe(`${MIN_PROMPT_HEIGHT}px`)
		fireEvent.pointerUp(grip, { pointerId: 1 })

		// Moving after the drag ended changes nothing.
		fireEvent.pointerMove(grip, { clientY: 300, pointerId: 1 })
		expect(box.style.height).toBe(`${MIN_PROMPT_HEIGHT}px`)
	})

	it("keeps the dragged height when the row is mounted again", () => {
		restoreLayout = stubLayout(CONTENT_HEIGHT, SHOWN_HEIGHT)
		const { unmount } = render(
			<ResizablePromptText defaultMaxHeight={SHOWN_HEIGHT} messageTs={3}>
				Long prompt
			</ResizablePromptText>,
		)
		const grip = screen.getByTestId("prompt-resize-grip")
		fireEvent.pointerDown(grip, { button: 0, clientY: 0, pointerId: 1 })
		fireEvent.pointerMove(grip, { clientY: 60, pointerId: 1 })
		fireEvent.pointerUp(grip, { pointerId: 1 })
		unmount()

		render(
			<ResizablePromptText defaultMaxHeight={SHOWN_HEIGHT} messageTs={3}>
				Long prompt
			</ResizablePromptText>,
		)
		expect(screen.getByTestId("prompt-text-scroll").style.height).toBe(`${SHOWN_HEIGHT + 60}px`)
	})

	it("double-click shows the whole prompt, and again goes back to the default height", () => {
		restoreLayout = stubLayout(CONTENT_HEIGHT, SHOWN_HEIGHT)
		render(
			<ResizablePromptText defaultMaxHeight={SHOWN_HEIGHT} messageTs={4}>
				Long prompt
			</ResizablePromptText>,
		)
		const grip = screen.getByTestId("prompt-resize-grip")
		const box = screen.getByTestId("prompt-text-scroll")

		fireEvent.doubleClick(grip)
		expect(box.style.height).toBe(`${CONTENT_HEIGHT}px`)
		fireEvent.doubleClick(grip)
		expect(box.style.height).toBe("")
		expect(box.style.maxHeight).toBe(`${SHOWN_HEIGHT}px`)
	})

	it("arrow keys resize from the keyboard", () => {
		restoreLayout = stubLayout(CONTENT_HEIGHT, SHOWN_HEIGHT)
		render(
			<ResizablePromptText defaultMaxHeight={SHOWN_HEIGHT} messageTs={5}>
				Long prompt
			</ResizablePromptText>,
		)
		const grip = screen.getByTestId("prompt-resize-grip")
		fireEvent.keyDown(grip, { key: "ArrowDown" })
		expect(screen.getByTestId("prompt-text-scroll").style.height).toBe(`${SHOWN_HEIGHT + 24}px`)
	})

	it("using the grip on a prompt bubble does not open it for editing", () => {
		restoreLayout = stubLayout(CONTENT_HEIGHT, SHOWN_HEIGHT)
		render(<UserMessage messageTs={6} text="A long prompt" />)
		const grip = screen.getByTestId("prompt-resize-grip")

		fireEvent.pointerDown(grip, { button: 0, clientY: 0, pointerId: 1 })
		fireEvent.pointerUp(grip, { pointerId: 1 })
		fireEvent.click(grip)
		fireEvent.doubleClick(grip)
		fireEvent.keyDown(grip, { key: "Enter" })

		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()

		fireEvent.click(screen.getByText("A long prompt"))
		expect(screen.getByRole("textbox")).toBeInTheDocument()
	})
})
