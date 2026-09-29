import type { Mode } from "@shared/storage/types"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { AtSignIcon, PlusIcon } from "lucide-react"
import { useMemo } from "react"
import styled from "styled-components"
import { ConversationModelPicker } from "@/components/chat/ConversationModelPicker"
import ServersToggleModal from "@/components/chat/ServersToggleModal"
import ClineRulesToggleModal from "@/components/cline-rules/ClineRulesToggleModal"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useNormalizedApiConfiguration } from "@/hooks/useNormalizedApiConfiguration"

const ButtonGroup = styled.div`
	display: flex;
	align-items: center;
	gap: 4px;
	flex: 1;
	min-width: 0;
`

const ButtonContainer = styled.div`
	display: flex;
	align-items: center;
	gap: 3px;
	font-size: 10px;
	white-space: nowrap;
	min-width: 0;
	width: 100%;
`

const ModelContainer = styled.div`
	position: relative;
	display: flex;
	flex: 1;
	min-width: 0;
`

const ModelButtonWrapper = styled.div`
	display: inline-flex; // Make it shrink to content
	min-width: 0; // Allow shrinking
	max-width: 100%; // Don't overflow parent
`

const ModelDisplayButton = styled.a<{ isActive?: boolean; disabled?: boolean }>`
	padding: 0px 0px;
	height: 20px;
	width: 100%;
	min-width: 0;
	cursor: ${(props) => (props.disabled ? "not-allowed" : "pointer")};
	text-decoration: ${(props) => (props.isActive ? "underline" : "none")};
	color: ${(props) => (props.isActive ? "var(--vscode-foreground)" : "var(--vscode-descriptionForeground)")};
	display: flex;
	align-items: center;
	font-size: 10px;
	outline: none;
	user-select: none;
	opacity: ${(props) => (props.disabled ? 0.5 : 1)};
	pointer-events: ${(props) => (props.disabled ? "none" : "auto")};

	&:hover,
	&:focus {
		color: ${(props) => (props.disabled ? "var(--vscode-descriptionForeground)" : "var(--vscode-foreground)")};
		text-decoration: ${(props) => (props.disabled ? "none" : "underline")};
		outline: none;
	}

	&:active {
		color: ${(props) => (props.disabled ? "var(--vscode-descriptionForeground)" : "var(--vscode-foreground)")};
		text-decoration: ${(props) => (props.disabled ? "none" : "underline")};
		outline: none;
	}

	&:focus-visible {
		outline: none;
	}
`

const ModelButtonContent = styled.div`
	width: 100%;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
`

interface ModelButtonProps {
	mode: Mode
	handleContextButtonClick: () => void
	shouldDisableFilesAndImages: boolean
	onSelectFilesAndImages: () => void
}

/**
 * The toolbar row below the textarea: add-context and add-files-and-images
 * buttons, the MCP servers and workspace rules toggles, and the model picker.
 * Always rendered (visibility is controlled by the parent's CSS), so it has
 * no state of its own beyond what it's given.
 */
export function ModelButton({
	mode,
	handleContextButtonClick,
	shouldDisableFilesAndImages,
	onSelectFilesAndImages,
}: ModelButtonProps) {
	const { apiConfiguration } = useExtensionState()
	const { selectedProvider, selectedModelId } = useNormalizedApiConfiguration(mode)

	// Get model display name
	const modelDisplayName = useMemo(() => {
		if (!apiConfiguration) {
			return "unknown"
		}
		return `${selectedProvider}:${selectedModelId}`
	}, [apiConfiguration, selectedProvider, selectedModelId])

	return (
		<ButtonGroup className="absolute top-0 left-0 right-0 ease-in-out w-full h-5 z-10 flex items-center">
			<Tooltip>
				<TooltipContent>Add Context</TooltipContent>
				<TooltipTrigger>
					<VSCodeButton
						appearance="icon"
						aria-label="Add Context"
						className="p-0 m-0 flex items-center"
						data-testid="context-button"
						onClick={handleContextButtonClick}>
						<ButtonContainer>
							<AtSignIcon size={12} />
						</ButtonContainer>
					</VSCodeButton>
				</TooltipTrigger>
			</Tooltip>

			<Tooltip>
				<TooltipContent>Add Files & Images</TooltipContent>
				<TooltipTrigger>
					<VSCodeButton
						appearance="icon"
						aria-label="Add Files & Images"
						className="p-0 m-0 flex items-center"
						data-testid="files-button"
						disabled={shouldDisableFilesAndImages}
						onClick={() => {
							if (!shouldDisableFilesAndImages) {
								onSelectFilesAndImages()
							}
						}}>
						<ButtonContainer>
							<PlusIcon size={13} />
						</ButtonContainer>
					</VSCodeButton>
				</TooltipTrigger>
			</Tooltip>

			<ServersToggleModal />

			<ClineRulesToggleModal />

			<ModelContainer>
				<ConversationModelPicker mode={mode} />
			</ModelContainer>
		</ButtonGroup>
	)
}
