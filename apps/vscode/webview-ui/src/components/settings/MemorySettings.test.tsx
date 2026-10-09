import { PLINY_REPO_MEMORY_URI, PLINY_USER_MEMORY_URI } from "@shared/pliny"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import MemorySettings from "./MemorySettings"

const mockUpdateSetting = vi.fn()
const mockOpenFile = vi.fn((_request: { value: string }) => Promise.resolve({}))
const state = vi.hoisted(() => ({
	value: { memoryMaxTokens: 4000, memoryDistillEnabled: true, memoryConversationSearchEnabled: true } as Record<
		string,
		unknown
	>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => state.value,
}))

vi.mock("./utils/settingsHandlers", () => ({
	updateSetting: (...args: unknown[]) => mockUpdateSetting(...args),
}))

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: { openFile: (request: { value: string }) => mockOpenFile(request) },
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ id, value, onInput, onBlur }: any) => (
		<input id={id} onBlur={onBlur} onInput={onInput} readOnly={false} value={value} />
	),
	VSCodeLink: ({ children, onClick }: any) => (
		<a href="#" onClick={onClick}>
			{children}
		</a>
	),
}))

describe("MemorySettings", () => {
	beforeEach(() => {
		mockUpdateSetting.mockClear()
		mockOpenFile.mockClear()
		state.value = { memoryMaxTokens: 4000, memoryDistillEnabled: true, memoryConversationSearchEnabled: true }
	})

	it("shows the budget and saves a valid new one", () => {
		const { container } = render(<MemorySettings />)
		const input = container.querySelector("#memory-max-tokens") as HTMLInputElement
		expect(input.value).toBe("4000")

		fireEvent.input(input, { target: { value: "8000" } })
		expect(mockUpdateSetting).toHaveBeenCalledWith("memoryMaxTokens", 8000)
	})

	it("rejects a budget that is not a whole number in range", () => {
		const { container } = render(<MemorySettings />)
		const input = container.querySelector("#memory-max-tokens") as HTMLInputElement
		for (const value of ["-1", "1.5", "abc", "100000"]) {
			fireEvent.input(input, { target: { value } })
		}
		expect(mockUpdateSetting).not.toHaveBeenCalled()
		expect(screen.getByText(/Enter a whole number from 0 to 64,000/)).toBeTruthy()
	})

	it("toggles proposals and conversation search", () => {
		const { container } = render(<MemorySettings />)
		fireEvent.click(container.querySelector("#memory-distill") as Element)
		expect(mockUpdateSetting).toHaveBeenCalledWith("memoryDistillEnabled", false)
		fireEvent.click(container.querySelector("#memory-conversation-search") as Element)
		expect(mockUpdateSetting).toHaveBeenCalledWith("memoryConversationSearchEnabled", false)
	})

	it("disables proposals while memory is off", () => {
		state.value = { ...state.value, memoryMaxTokens: 0 }
		const { container } = render(<MemorySettings />)
		const distill = container.querySelector("#memory-distill") as HTMLButtonElement
		expect(distill.disabled).toBe(true)
		expect(distill.getAttribute("aria-checked")).toBe("false")
	})

	it("opens the repository's and the user's memory file", () => {
		render(<MemorySettings />)
		fireEvent.click(screen.getByText("Open repository memory"))
		fireEvent.click(screen.getByText("Open your memory"))
		expect(mockOpenFile.mock.calls.map(([request]) => request.value)).toEqual([PLINY_REPO_MEMORY_URI, PLINY_USER_MEMORY_URI])
	})
})
