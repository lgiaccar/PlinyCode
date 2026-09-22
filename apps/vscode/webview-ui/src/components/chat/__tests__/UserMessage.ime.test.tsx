/**
 * UserMessage – IME composition Enter test
 * --------------------------------------------------
 * Confirm that sendMessageFromChatRow is not called
 * even if you confirm the IME conversion (Enter) in message re-edit mode.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/context/ExtensionStateContext", () => ({
	__esModule: true,
	useExtensionState: () => ({
		state: {},
		dispatch: vi.fn(),
	}),
}))

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		editMessageAndRegenerate: vi.fn(),
	},
	CheckpointsServiceClient: {
		checkpointLatestChangesSummary: vi.fn(),
	},
}))

import { CheckpointsServiceClient, TaskServiceClient } from "@/services/grpc-client"
import UserMessage from "../UserMessage"

describe("UserMessage – IME composition handling", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.stubGlobal(
			"ResizeObserver",
			class ResizeObserver {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
		vi.mocked(TaskServiceClient.editMessageAndRegenerate).mockResolvedValue({})
		vi.mocked(CheckpointsServiceClient.checkpointLatestChangesSummary).mockResolvedValue({
			files: [],
			totalAdded: 0,
			totalRemoved: 0,
			checkpointRunCount: 1,
		})
	})

	it("does NOT send when IME composition Enter is pressed while editing", () => {
		const sendMessageFromChatRow = vi.fn()

		const { getByText } = render(
			<UserMessage images={[]} messageTs={Date.now()} sendMessageFromChatRow={sendMessageFromChatRow} text="変換テスト" />,
		)

		const editable = getByText("変換テスト") as HTMLElement
		editable.setAttribute("contenteditable", "true")
		editable.focus()

		fireEvent.compositionStart(editable)
		fireEvent.keyDown(editable, {
			key: "Enter",
			keyCode: 13,
			nativeEvent: { isComposing: true },
		})
		fireEvent.compositionEnd(editable)

		expect(sendMessageFromChatRow).not.toHaveBeenCalled()
	})

	it("cancels inline editing on Escape without bubbling to global task shortcuts", () => {
		const onWindowKeyDown = vi.fn()
		window.addEventListener("keydown", onWindowKeyDown)

		try {
			render(<UserMessage images={[]} messageTs={Date.now()} text="Original prompt" />)

			fireEvent.click(screen.getByText("Original prompt"))

			const textbox = screen.getByRole("textbox")
			fireEvent.change(textbox, { target: { value: "Edited prompt" } })

			fireEvent.keyDown(textbox, { key: "Escape" })

			expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
			expect(screen.getByText("Original prompt")).toBeInTheDocument()
			expect(onWindowKeyDown).not.toHaveBeenCalled()
		} finally {
			window.removeEventListener("keydown", onWindowKeyDown)
		}
	})

	it("shows the pencil control and restart actions with expected behavior", async () => {
		const user = userEvent.setup()
		render(<UserMessage files={["src/app.ts"]} images={["image.png"]} messageTs={123} text="Update this" />)

		expect(screen.getByLabelText("Edit and restart from this message")).toBeInTheDocument()

		await user.click(screen.getByText("Update this"))

		expect(screen.getByRole("button", { name: "Restart from here" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Restart and revert files" })).toBeInTheDocument()

		await user.click(screen.getByRole("button", { name: "Restart from here" }))
		await waitFor(() => expect(TaskServiceClient.editMessageAndRegenerate).toHaveBeenCalledTimes(1))
		expect(TaskServiceClient.editMessageAndRegenerate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				messageTs: 123,
				text: "Update this",
				images: ["image.png"],
				files: ["src/app.ts"],
				restoreWorkspace: false,
			}),
		)

		await user.click(screen.getByText("Update this"))
		await user.click(screen.getByRole("button", { name: "Restart and revert files" }))
		await waitFor(() => expect(CheckpointsServiceClient.checkpointLatestChangesSummary).toHaveBeenCalled())
		await user.click(screen.getByRole("button", { name: "Revert files and restart" }))
		await waitFor(() => expect(TaskServiceClient.editMessageAndRegenerate).toHaveBeenCalledTimes(2))
		expect(TaskServiceClient.editMessageAndRegenerate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				messageTs: 123,
				restoreWorkspace: true,
			}),
		)
	})

	it("disables revert files when workspace restore is unavailable", async () => {
		const user = userEvent.setup()
		render(
			<UserMessage
				canRestoreWorkspace={false}
				messageTs={123}
				restoreWorkspaceDisabledReason="No git checkpoint"
				text="Hi"
			/>,
		)

		await user.click(screen.getByText("Hi"))
		expect(screen.getByRole("button", { name: "Restart and revert files" })).toBeDisabled()
	})

	it("removes an image before regenerating an edited message", async () => {
		const user = userEvent.setup()
		render(<UserMessage images={["image.png"]} messageTs={123} text="Update this" />)

		await user.click(screen.getByText("Update this"))
		const thumbnail = screen.getByAltText("Thumbnail image-1")
		fireEvent.mouseEnter(thumbnail.parentElement as HTMLElement)
		const removeButton = thumbnail.parentElement?.querySelector(".codicon-close")?.parentElement
		expect(removeButton).not.toBeNull()
		await user.click(removeButton as HTMLElement)

		expect(screen.queryByAltText("Thumbnail image-1")).not.toBeInTheDocument()
		await user.click(screen.getByRole("button", { name: "Restart from here" }))
		await waitFor(() => expect(TaskServiceClient.editMessageAndRegenerate).toHaveBeenCalledTimes(1))
		expect(TaskServiceClient.editMessageAndRegenerate).toHaveBeenCalledWith(expect.objectContaining({ images: [] }))
	})
})
