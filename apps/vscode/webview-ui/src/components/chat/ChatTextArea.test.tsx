import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import ChatTextArea from "./ChatTextArea"

const mocks = vi.hoisted(() => ({
	supportsImages: true as boolean | undefined,
	navigateToSettingsModelPicker: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mode: "act",
		apiConfiguration: {},
		openRouterModels: {},
		platform: "darwin",
		localWorkflowToggles: {},
		globalWorkflowToggles: {},
		remoteWorkflowToggles: {},
		remoteConfigSettings: undefined,
		navigateToSettingsModelPicker: mocks.navigateToSettingsModelPicker,
		mcpServers: [],
		// useProviderModels() refreshes on mount; without these the request
		// rejects asynchronously and vitest reports an unhandled error.
		startProviderModelsRequest: vi.fn(),
		applyProviderModelsResponse: vi.fn(),
		providerModelsByProvider: {},
	}),
}))

vi.mock("@/context/PlatformContext", () => ({
	usePlatform: () => ({ togglePlanActKeys: "Meta+Shift+a" }),
}))

vi.mock("@/hooks/useNormalizedApiConfiguration", () => ({
	useNormalizedApiConfiguration: () => ({
		selectedProvider: "anthropic",
		selectedModelId: "text-only-model",
		selectedModelInfo: { supportsImages: mocks.supportsImages },
	}),
}))

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: {
		searchCommits: vi.fn(async () => ({ commits: [] })),
		searchFiles: vi.fn(async () => ({ results: [] })),
		getRelativePaths: vi.fn(async () => ({ paths: [] })),
		openImage: vi.fn(async () => ({})),
		openFile: vi.fn(async () => ({})),
	},
	StateServiceClient: {
		togglePlanActModeProto: vi.fn(async () => ({})),
	},
	// ConversationModelPicker -> useProviderConfig() reads the provider config on
	// mount; without this the call rejects and vitest reports an unhandled error.
	ModelsServiceClient: {
		readProviderConfig: vi.fn(async () => ({})),
		writeProviderConfig: vi.fn(async () => ({})),
		commitModelSelection: vi.fn(async () => ({})),
	},
}))

vi.mock("../cline-rules/ClineRulesToggleModal", () => ({ default: () => null }))
vi.mock("./ServersToggleModal", () => ({ default: () => null }))

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo="

function renderTextArea(selectedImages: string[] = []) {
	const setSelectedImages = vi.fn()
	render(
		<ChatTextArea
			activeQuote={null}
			inputValue=""
			onSelectFilesAndImages={vi.fn()}
			onSend={vi.fn()}
			placeholderText="Type a message"
			selectedFiles={[]}
			selectedImages={selectedImages}
			sendingDisabled={false}
			setInputValue={vi.fn()}
			setSelectedFiles={vi.fn()}
			setSelectedImages={setSelectedImages}
			shouldDisableFilesAndImages={false}
		/>,
	)
	return { textarea: screen.getByPlaceholderText("Type a message"), setSelectedImages }
}

function pasteImage(target: HTMLElement) {
	const file = new File(["png"], "screenshot.png", { type: "image/png" })
	return fireEvent.paste(target, {
		clipboardData: {
			items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
			getData: () => "",
		},
	})
}

describe("ChatTextArea image attachments vs. model capability", () => {
	beforeEach(() => {
		mocks.supportsImages = true
		mocks.navigateToSettingsModelPicker.mockReset()
	})

	it("still takes the image attach path on paste for a text-only model, without a refusal message", () => {
		mocks.supportsImages = false
		const { textarea } = renderTextArea()

		const notCanceled = pasteImage(textarea)

		expect(notCanceled).toBe(false) // preventDefault: the paste was handled as an image, not as text
		expect(screen.queryByText(/ignored/)).not.toBeInTheDocument()
	})

	it("badges attached images and offers a model switch when the model is text-only", () => {
		mocks.supportsImages = false
		renderTextArea([PNG_DATA_URL, PNG_DATA_URL])

		const notice = screen.getByTestId("images-unsupported-notice")
		expect(notice).toHaveTextContent("text-only-model doesn't support images, so the 2 attached images will be ignored.")
		expect(screen.getAllByTestId("image-unsupported-badge")).toHaveLength(2)

		// A native button, so keyboard users get Enter/Space activation without extra handlers.
		const chooseModel = screen.getByRole("button", { name: "Choose an image-capable model" })
		expect(chooseModel.tagName).toBe("BUTTON")
		fireEvent.click(chooseModel)
		expect(mocks.navigateToSettingsModelPicker).toHaveBeenCalledWith({ targetSection: "api-config" })
	})

	it("uses singular wording for one image", () => {
		mocks.supportsImages = false
		renderTextArea([PNG_DATA_URL])

		expect(screen.getByTestId("images-unsupported-notice")).toHaveTextContent("the attached image will be ignored")
		expect(screen.getByTestId("images-unsupported-notice")).toHaveTextContent("or remove it.")
	})

	it("shows nothing extra when the model supports images", () => {
		renderTextArea([PNG_DATA_URL])

		expect(screen.queryByTestId("images-unsupported-notice")).not.toBeInTheDocument()
		expect(screen.queryByTestId("image-unsupported-badge")).not.toBeInTheDocument()
	})

	it("fails open when the model's image support is unknown", () => {
		mocks.supportsImages = undefined
		renderTextArea([PNG_DATA_URL])

		expect(screen.queryByTestId("images-unsupported-notice")).not.toBeInTheDocument()
	})

	it("shows nothing for a text-only model while no images are attached", () => {
		mocks.supportsImages = false
		renderTextArea()

		expect(screen.queryByTestId("images-unsupported-notice")).not.toBeInTheDocument()
	})
})

describe("ChatTextArea sticky send mode", () => {
	const store = new Map<string, string>()
	const localStorage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		clear: () => store.clear(),
	}

	beforeEach(() => {
		store.clear()
		vi.stubGlobal("localStorage", localStorage)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	function renderWithSend() {
		const onSend = vi.fn()
		render(
			<ChatTextArea
				activeQuote={null}
				inputValue="hello"
				onSelectFilesAndImages={vi.fn()}
				onSend={onSend}
				placeholderText="Type a message"
				selectedFiles={[]}
				selectedImages={[]}
				sendingDisabled={false}
				setInputValue={vi.fn()}
				setSelectedFiles={vi.fn()}
				setSelectedImages={vi.fn()}
				shouldDisableFilesAndImages={false}
			/>,
		)
		return { onSend, button: screen.getByTestId("send-button"), select: screen.getByTestId("send-mode-select") }
	}

	it("sends with the default delivery and the send icon by default", () => {
		const { onSend, button } = renderWithSend()
		expect(button).toHaveClass("codicon-send")
		fireEvent.click(button)
		expect(onSend).toHaveBeenCalledWith(undefined)
	})

	it("changing the mode does not send, updates the icon and persists", () => {
		const { onSend, button, select } = renderWithSend()
		fireEvent.change(select, { target: { value: "steer" } })
		expect(onSend).not.toHaveBeenCalled()
		expect(button).toHaveClass("codicon-zap")
		expect(localStorage.getItem("plinycode.sendMode")).toBe("steer")

		fireEvent.click(button)
		expect(onSend).toHaveBeenCalledWith("steer")
	})

	it("Enter sends with the sticky mode", () => {
		const { onSend, select } = renderWithSend()
		fireEvent.change(select, { target: { value: "steer" } })
		fireEvent.keyDown(screen.getByPlaceholderText("Type a message"), { key: "Enter" })
		expect(onSend).toHaveBeenCalledWith("steer")
	})

	it("restores the stored mode and opens the picker in schedule mode", () => {
		localStorage.setItem("plinycode.sendMode", "schedule")
		const { onSend, button } = renderWithSend()
		expect(button).toHaveClass("codicon-watch")
		fireEvent.click(button)
		expect(onSend).not.toHaveBeenCalled()
		expect(screen.getByRole("button", { name: "Schedule" })).toBeInTheDocument()
	})

	it("offers only Send, Send now (steering) and Schedule", () => {
		const { select } = renderWithSend()
		const values = Array.from(select.querySelectorAll("option")).map((option) => option.getAttribute("value"))
		expect(values).toEqual(["default", "steer", "schedule"])
	})

	it("falls back to Send for the removed queue mode", () => {
		localStorage.setItem("plinycode.sendMode", "queue")
		const { onSend, button } = renderWithSend()
		expect(button).toHaveClass("codicon-send")
		fireEvent.click(button)
		expect(onSend).toHaveBeenCalledWith(undefined)
	})

	it("falls back to the default mode for an invalid stored value", () => {
		localStorage.setItem("plinycode.sendMode", "bogus")
		const { button } = renderWithSend()
		expect(button).toHaveClass("codicon-send")
	})
})
