import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import ChatTextArea from "./ChatTextArea"

function Composer() {
	const [draft, setDraft] = useState("Explain how the CI Board handles expired pipelines.")
	const [images, setImages] = useState<string[]>([])
	const [files, setFiles] = useState<string[]>([])
	return (
		<ChatTextArea
			activeQuote={null}
			inputValue={draft}
			onSelectFilesAndImages={() => {}}
			onSend={() => {}}
			placeholderText="Type a message"
			selectedFiles={files}
			selectedImages={images}
			sendingDisabled={false}
			setInputValue={setDraft}
			setSelectedFiles={setFiles}
			setSelectedImages={setImages}
			shouldDisableFilesAndImages={false}
			sideQuestionAvailable
		/>
	)
}

export default {
	title: "PlinyCode/Composer",
	component: Composer,
	parameters: { layout: "fullscreen" },
	decorators: [
		createStorybookDecorator({
			mode: "act",
			apiConfiguration: { actModeApiProvider: "pliny", actModeApiModelId: "pliny/auto-free" },
		}),
	],
} satisfies Meta<typeof Composer>
export const RightActions: StoryObj<typeof Composer> = {}
