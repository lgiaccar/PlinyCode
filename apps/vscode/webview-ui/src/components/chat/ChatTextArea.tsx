import { mentionRegexGlobal } from "@shared/context-mentions"
import { PlanActMode, TogglePlanActModeRequest } from "@shared/proto/cline/state"
import { TriangleAlertIcon } from "lucide-react"
import type React from "react"
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import DynamicTextArea from "react-textarea-autosize"
import ContextMenu from "@/components/chat/ContextMenu"
import SlashCommandMenu from "@/components/chat/SlashCommandMenu"
import Thumbnails from "@/components/common/Thumbnails"
import { updateSetting } from "@/components/settings/utils/settingsHandlers"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { usePlatform } from "@/context/PlatformContext"
import { useNormalizedApiConfiguration } from "@/hooks/useNormalizedApiConfiguration"
import { cn } from "@/lib/utils"
import { StateServiceClient } from "@/services/grpc-client"
import { shouldShowContextMenu } from "@/utils/context-mentions"
import { useMetaKeyDetection, useShortcut } from "@/utils/hooks"
import { shouldShowSlashCommandsMenu, slashCommandRegexGlobal, validateSlashCommand } from "@/utils/slash-commands"
import { ModelButton } from "./chat-textarea/components/ModelButton"
import { ModeSwitch, PLAN_MODE_COLOR } from "./chat-textarea/components/ModeSwitch"
import { useComposerKeyboardHandler } from "./chat-textarea/hooks/useComposerKeyboardHandler"
import { DEFAULT_CONTEXT_MENU_OPTION, useContextMenu } from "./chat-textarea/hooks/useContextMenu"
import { useDropHandling } from "./chat-textarea/hooks/useDropHandling"
import {
	getRowHeightPx,
	MAX_CHAT_INPUT_MAX_ROWS,
	MIN_CHAT_INPUT_MAX_ROWS,
	rowsFromDrag,
	useResizableRows,
} from "./chat-textarea/hooks/useResizableRows"
import { useSchedulePicker } from "./chat-textarea/hooks/useSchedulePicker"
import { useSlashCommandMenu } from "./chat-textarea/hooks/useSlashCommandMenu"
import { getModeToggleDraftAction } from "./chat-textarea-mode-toggle"
import ScheduleTimeInput, { ScheduleRepeatInput } from "./ScheduleTimeInput"
import { defaultScheduleTime, type ScheduleRepeat } from "./scheduleTime"
import { deliveryFor, loadSendMode, SEND_MODE_META, SEND_MODES, type SendDelivery, type SendMode, saveSendMode } from "./sendMode"

// Re-exported so ChatTextArea.test.tsx (and anything else importing from this
// module) keeps working unchanged after these moved into useResizableRows.
export { getRowHeightPx, rowsFromDrag }

interface ChatTextAreaProps {
	inputValue: string
	activeQuote: string | null
	setInputValue: (value: string) => void
	sendingDisabled: boolean
	placeholderText: string
	selectedFiles: string[]
	selectedImages: string[]
	setSelectedImages: React.Dispatch<React.SetStateAction<string[]>>
	setSelectedFiles: React.Dispatch<React.SetStateAction<string[]>>
	onSend: (delivery?: SendDelivery) => void
	onSchedulePrompt?: (text: string, images: string[], files: string[], scheduledAt: number, repeat?: ScheduleRepeat) => void
	onSelectFilesAndImages: () => void
	shouldDisableFilesAndImages: boolean
	onHeightChange?: (height: number) => void
	onFocusChange?: (isFocused: boolean) => void
}

const ChatTextArea = forwardRef<HTMLTextAreaElement, ChatTextAreaProps>(
	(
		{
			inputValue,
			setInputValue,
			sendingDisabled,
			placeholderText,
			selectedFiles,
			selectedImages,
			setSelectedImages,
			setSelectedFiles,
			onSend,
			onSchedulePrompt,
			onSelectFilesAndImages,
			shouldDisableFilesAndImages,
			onHeightChange,
			onFocusChange,
		},
		ref,
	) => {
		const {
			mode,
			platform,
			localWorkflowToggles,
			globalWorkflowToggles,
			navigateToSettingsModelPicker,
			mcpServers,
			chatInputMaxRows: persistedChatInputMaxRows,
		} = useExtensionState()
		const [isTextAreaFocused, setIsTextAreaFocused] = useState(false)

		const [thumbnailsHeight, setThumbnailsHeight] = useState(0)
		const [textAreaBaseHeight, setTextAreaBaseHeight] = useState<number | undefined>(undefined)
		const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
		const [isMouseDownOnMenu, setIsMouseDownOnMenu] = useState(false)
		const highlightLayerRef = useRef<HTMLDivElement>(null)
		const [justDeletedSpaceAfterSlashCommand, setJustDeletedSpaceAfterSlashCommand] = useState(false)

		const [sendMode, setSendMode] = useState<SendMode>(loadSendMode)

		const [, metaKeyChar] = useMetaKeyDetection(platform)
		const { selectedModelId, selectedModelInfo } = useNormalizedApiConfiguration(mode)
		// Images are attached regardless; when the selected model has no image input the thumbnails get a warning
		// badge and a notice offers to switch models. Unknown capability data fails open, like core does.
		const modelSupportsImages = selectedModelInfo.supportsImages !== false
		const unsupportedImagesAttached = selectedImages.length > 0 && !modelSupportsImages

		const { maxRows, setMaxRows, isDraggingMaxHeight, handleMaxHeightDragMouseDown } = useResizableRows(
			persistedChatInputMaxRows,
			textAreaRef,
		)

		const {
			showContextMenu,
			setShowContextMenu,
			selectedMenuIndex,
			setSelectedMenuIndex,
			selectedType,
			setSelectedType,
			searchQuery,
			setSearchQuery,
			cursorPosition,
			setCursorPosition,
			justDeletedSpaceAfterMention,
			setJustDeletedSpaceAfterMention,
			intendedCursorPosition,
			setIntendedCursorPosition,
			contextMenuContainerRef,
			fileSearchResults,
			setFileSearchResults,
			searchLoading,
			queryItems,
			handleMentionSelect,
			triggerFileSearch,
		} = useContextMenu(setInputValue, textAreaRef)

		const {
			showSlashCommandsMenu,
			setShowSlashCommandsMenu,
			selectedSlashCommandsIndex,
			setSelectedSlashCommandsIndex,
			slashCommandsQuery,
			setSlashCommandsQuery,
			slashCommandsMenuContainerRef,
			handleSlashCommandsSelect,
		} = useSlashCommandMenu(setInputValue, textAreaRef, cursorPosition, setCursorPosition, setIntendedCursorPosition)

		const {
			isDraggingOver,
			showUnsupportedFileError,
			showDimensionError,
			handlePaste,
			handleDragEnter,
			onDragOver,
			handleDragLeave,
			onDrop,
		} = useDropHandling(
			inputValue,
			cursorPosition,
			setCursorPosition,
			setInputValue,
			intendedCursorPosition,
			setIntendedCursorPosition,
			textAreaRef,
			selectedImages,
			selectedFiles,
			setSelectedImages,
			shouldDisableFilesAndImages,
		)

		const {
			showSchedulePicker,
			setShowSchedulePicker,
			scheduleTime,
			setScheduleTime,
			repeatCount,
			setRepeatCount,
			repeatEvery,
			setRepeatEvery,
			repeatUnit,
			setRepeatUnit,
			confirmSchedule,
		} = useSchedulePicker(
			inputValue,
			selectedImages,
			selectedFiles,
			setInputValue,
			setSelectedImages,
			setSelectedFiles,
			onSchedulePrompt,
		)

		// Sends with the sticky send mode. Schedule mode opens the time picker
		// first, and confirms it once a time is chosen.
		const triggerSend = useCallback(() => {
			if (sendMode === "schedule") {
				if (showSchedulePicker && scheduleTime) {
					confirmSchedule()
				} else {
					setScheduleTime((current) => current || defaultScheduleTime())
					setShowSchedulePicker(true)
				}
				return
			}
			onSend(deliveryFor(sendMode))
		}, [sendMode, showSchedulePicker, scheduleTime, confirmSchedule, onSend, setScheduleTime, setShowSchedulePicker])

		const handleKeyDown = useComposerKeyboardHandler({
			inputValue,
			setInputValue,
			cursorPosition,
			setCursorPosition,
			setIntendedCursorPosition,
			sendingDisabled,
			triggerSend,
			textAreaRef,
			localWorkflowToggles,
			globalWorkflowToggles,
			mcpServers,
			showContextMenu,
			setShowContextMenu,
			selectedMenuIndex,
			setSelectedMenuIndex,
			selectedType,
			setSelectedType,
			searchQuery,
			setSearchQuery,
			queryItems,
			fileSearchResults,
			handleMentionSelect,
			justDeletedSpaceAfterMention,
			setJustDeletedSpaceAfterMention,
			defaultContextMenuOption: DEFAULT_CONTEXT_MENU_OPTION,
			showSlashCommandsMenu,
			setShowSlashCommandsMenu,
			selectedSlashCommandsIndex,
			setSelectedSlashCommandsIndex,
			slashCommandsQuery,
			setSlashCommandsQuery,
			handleSlashCommandsSelect,
			justDeletedSpaceAfterSlashCommand,
			setJustDeletedSpaceAfterSlashCommand,
		})

		// Effect to set cursor position after state updates
		useLayoutEffect(() => {
			if (intendedCursorPosition !== null && textAreaRef.current) {
				textAreaRef.current.setSelectionRange(intendedCursorPosition, intendedCursorPosition)
				setIntendedCursorPosition(null) // Reset the state after applying
			}
		}, [inputValue, intendedCursorPosition, setIntendedCursorPosition])

		const handleInputChange = useCallback(
			(e: React.ChangeEvent<HTMLTextAreaElement>) => {
				const newValue = e.target.value
				const newCursorPosition = e.target.selectionStart
				setInputValue(newValue)
				setCursorPosition(newCursorPosition)
				let showMenu = shouldShowContextMenu(newValue, newCursorPosition)
				const showSlashMenu = shouldShowSlashCommandsMenu(newValue, newCursorPosition)

				// we do not allow both menus to be shown at the same time
				// the slash commands menu has precedence bc its a narrower component
				if (showSlashMenu) {
					showMenu = false
				}

				setShowSlashCommandsMenu(showSlashMenu)
				setShowContextMenu(showMenu)

				if (showSlashMenu) {
					// Find the slash nearest to cursor (before cursor position)
					const beforeCursor = newValue.slice(0, newCursorPosition)
					const slashIndex = beforeCursor.lastIndexOf("/")
					const query = newValue.slice(slashIndex + 1, newCursorPosition)
					setSlashCommandsQuery(query)
					setSelectedSlashCommandsIndex(0)
				} else {
					setSlashCommandsQuery("")
					setSelectedSlashCommandsIndex(0)
				}

				if (showMenu) {
					const lastAtIndex = newValue.lastIndexOf("@", newCursorPosition - 1)
					const query = newValue.slice(lastAtIndex + 1, newCursorPosition)
					setSearchQuery(query)

					if (query.length > 0) {
						setSelectedMenuIndex(0)

						// Parse workspace hint from query (e.g., "@frontend:/filename")
						let workspaceHint: string | undefined
						let searchQueryValue = query
						const workspaceHintMatch = query.match(/^([\w-]+):\/(.*)$/)
						if (workspaceHintMatch) {
							workspaceHint = workspaceHintMatch[1]
							searchQueryValue = workspaceHintMatch[2]
						}

						triggerFileSearch(searchQueryValue, workspaceHint)
					} else {
						setSelectedMenuIndex(DEFAULT_CONTEXT_MENU_OPTION)
					}
				} else {
					setSearchQuery("")
					setSelectedMenuIndex(-1)
					setFileSearchResults([])
				}
			},
			[
				setInputValue,
				setFileSearchResults,
				setCursorPosition,
				setShowSlashCommandsMenu,
				setShowContextMenu,
				setSlashCommandsQuery,
				setSelectedSlashCommandsIndex,
				setSearchQuery,
				setSelectedMenuIndex,
				triggerFileSearch,
			],
		)

		const handleBlur = useCallback(() => {
			// Only hide the context menu if the user didn't click on it
			if (!isMouseDownOnMenu) {
				setShowContextMenu(false)
				setShowSlashCommandsMenu(false)
			}
			setIsTextAreaFocused(false)
			onFocusChange?.(false) // Call prop on blur
		}, [isMouseDownOnMenu, onFocusChange, setShowContextMenu, setShowSlashCommandsMenu])

		const handleThumbnailsHeightChange = useCallback((height: number) => {
			setThumbnailsHeight(height)
		}, [])

		useEffect(() => {
			if (selectedImages.length === 0 && selectedFiles.length === 0) {
				setThumbnailsHeight(0)
			}
		}, [selectedImages, selectedFiles])

		const handleMenuMouseDown = useCallback(() => {
			setIsMouseDownOnMenu(true)
		}, [])

		const updateHighlights = useCallback(() => {
			if (!textAreaRef.current || !highlightLayerRef.current) {
				return
			}

			let processedText = textAreaRef.current.value

			processedText = processedText
				.replace(/\n$/, "\n\n")
				.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] || c)
				// highlight @mentions
				.replace(mentionRegexGlobal, '<mark class="mention-context-textarea-highlight">$&</mark>')

			// Highlight only the FIRST valid /slash-command in the text
			// Only one slash command is processed per message, so we only highlight the first one
			slashCommandRegexGlobal.lastIndex = 0
			let hasHighlightedSlashCommand = false
			processedText = processedText.replace(slashCommandRegexGlobal, (match, prefix, command) => {
				// Only highlight the first valid slash command
				if (hasHighlightedSlashCommand) {
					return match
				}

				// Extract just the command name (without the slash)
				const commandName = command.substring(1)
				const isValidCommand = validateSlashCommand(commandName, localWorkflowToggles, globalWorkflowToggles)

				if (isValidCommand) {
					hasHighlightedSlashCommand = true
					// Keep the prefix (whitespace or empty) and wrap the command in highlight
					return `${prefix}<mark class="mention-context-textarea-highlight">${command}</mark>`
				}
				return match
			})

			highlightLayerRef.current.innerHTML = processedText
			highlightLayerRef.current.scrollTop = textAreaRef.current.scrollTop
			highlightLayerRef.current.scrollLeft = textAreaRef.current.scrollLeft
		}, [localWorkflowToggles, globalWorkflowToggles])

		useLayoutEffect(() => {
			updateHighlights()
		}, [inputValue, updateHighlights])

		const updateCursorPosition = useCallback(() => {
			if (textAreaRef.current) {
				setCursorPosition(textAreaRef.current.selectionStart)
			}
		}, [setCursorPosition])

		const handleKeyUp = useCallback(
			(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
				if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
					updateCursorPosition()
				}
			},
			[updateCursorPosition],
		)

		const onModeToggle = useCallback(() => {
			void (async () => {
				const convertedProtoMode = mode === "plan" ? PlanActMode.ACT : PlanActMode.PLAN
				const submittedText = inputValue
				const submittedImages = selectedImages
				const submittedFiles = selectedFiles
				const response = await StateServiceClient.togglePlanActModeProto(
					TogglePlanActModeRequest.create({
						mode: convertedProtoMode,
						chatContent: {
							message: submittedText.trim() ? submittedText : undefined,
							images: submittedImages,
							files: submittedFiles,
						},
					}),
				)
				// Focus the textarea after mode toggle with slight delay
				setTimeout(() => {
					const consumedComposerContent = response.value === true
					const currentText = textAreaRef.current?.value ?? ""
					// Reconcile only the submitted draft: the rebuild can take a moment
					// and the user may have typed new content in the meantime.
					const draftAction = getModeToggleDraftAction({
						consumed: consumedComposerContent,
						currentText,
						submittedText,
					})

					switch (draftAction) {
						case "clear":
							setInputValue("")
							break
						case "restore":
							setInputValue(submittedText)
							break
						case "keep":
							break
					}

					if (consumedComposerContent) {
						setSelectedImages((current) => (current === submittedImages ? [] : current))
						setSelectedFiles((current) => (current === submittedFiles ? [] : current))
					} else {
						if (submittedImages.length > 0) {
							setSelectedImages((current) => (current.length === 0 ? submittedImages : current))
						}
						if (submittedFiles.length > 0) {
							setSelectedFiles((current) => (current.length === 0 ? submittedFiles : current))
						}
					}
					textAreaRef.current?.focus()
				}, 100)
			})()
		}, [mode, inputValue, selectedImages, selectedFiles, setInputValue, setSelectedImages, setSelectedFiles])

		useShortcut(usePlatform().togglePlanActKeys, onModeToggle, { disableTextInputs: false }) // important that we don't disable the text input here

		const handleContextButtonClick = useCallback(() => {
			// Focus the textarea first
			textAreaRef.current?.focus()

			// If input is empty, just insert @
			if (!inputValue.trim()) {
				const event = {
					target: {
						value: "@",
						selectionStart: 1,
					},
				} as React.ChangeEvent<HTMLTextAreaElement>
				handleInputChange(event)
				updateHighlights()
				return
			}

			// If input ends with space or is empty, just append @
			if (inputValue.endsWith(" ")) {
				const event = {
					target: {
						value: inputValue + "@",
						selectionStart: inputValue.length + 1,
					},
				} as React.ChangeEvent<HTMLTextAreaElement>
				handleInputChange(event)
				updateHighlights()
				return
			}

			// Otherwise add space then @
			const event = {
				target: {
					value: inputValue + " @",
					selectionStart: inputValue.length + 2,
				},
			} as React.ChangeEvent<HTMLTextAreaElement>
			handleInputChange(event)
			updateHighlights()
		}, [inputValue, handleInputChange, updateHighlights])

		const handleModelButtonClick = () => {
			navigateToSettingsModelPicker({ targetSection: "api-config" })
		}

		// Replace Meta with the platform specific key and uppercase the command letter.
		const togglePlanActKeys = usePlatform()
			.togglePlanActKeys.replace("Meta", metaKeyChar)
			.replace(/.$/, (match) => match.toUpperCase())

		return (
			<div>
				<div
					className="relative flex transition-colors ease-in-out duration-100 px-3.5 py-2.5"
					onDragEnter={handleDragEnter}
					onDragLeave={handleDragLeave}
					onDragOver={onDragOver}
					onDrop={onDrop}>
					{showDimensionError && (
						<div className="absolute inset-2.5 bg-[rgba(var(--vscode-errorForeground-rgb),0.1)] border-2 border-error rounded-xs flex items-center justify-center z-10 pointer-events-none">
							<span className="text-error font-bold text-xs text-center">Image dimensions exceed 7500px</span>
						</div>
					)}
					{showUnsupportedFileError && (
						<div className="absolute inset-2.5 bg-[rgba(var(--vscode-errorForeground-rgb),0.1)] border-2 border-error rounded-xs flex items-center justify-center z-10 pointer-events-none">
							<span className="text-error font-bold text-xs">Files other than images are currently disabled</span>
						</div>
					)}
					{showSlashCommandsMenu && (
						<div ref={slashCommandsMenuContainerRef}>
							<SlashCommandMenu
								globalWorkflowToggles={globalWorkflowToggles}
								localWorkflowToggles={localWorkflowToggles}
								mcpServers={mcpServers}
								onMouseDown={handleMenuMouseDown}
								onSelect={handleSlashCommandsSelect}
								query={slashCommandsQuery}
								selectedIndex={selectedSlashCommandsIndex}
								setSelectedIndex={setSelectedSlashCommandsIndex}
							/>
						</div>
					)}

					{showContextMenu && (
						<div ref={contextMenuContainerRef}>
							<ContextMenu
								dynamicSearchResults={fileSearchResults}
								isLoading={searchLoading}
								onMouseDown={handleMenuMouseDown}
								onSelect={handleMentionSelect}
								queryItems={queryItems}
								searchQuery={searchQuery}
								selectedIndex={selectedMenuIndex}
								selectedType={selectedType}
								setSelectedIndex={setSelectedMenuIndex}
							/>
						</div>
					)}
					<div
						aria-label="Drag to resize the prompt box"
						aria-orientation="horizontal"
						aria-valuemax={MAX_CHAT_INPUT_MAX_ROWS}
						aria-valuemin={MIN_CHAT_INPUT_MAX_ROWS}
						aria-valuenow={maxRows}
						className="absolute left-3.5 right-3.5 top-1 z-2 rounded-xs"
						data-testid="chat-textarea-resize-handle"
						onKeyDown={(e) => {
							// Keyboard equivalent for the mouse drag: Up/Down grow/shrink by one row.
							if (e.key === "ArrowUp" || e.key === "ArrowDown") {
								e.preventDefault()
								const delta = e.key === "ArrowUp" ? 1 : -1
								setMaxRows((current) => {
									const next = Math.min(
										MAX_CHAT_INPUT_MAX_ROWS,
										Math.max(MIN_CHAT_INPUT_MAX_ROWS, current + delta),
									)
									updateSetting("chatInputMaxRows", next)
									return next
								})
							}
						}}
						onMouseDown={handleMaxHeightDragMouseDown}
						role="slider"
						style={{
							height: 5,
							cursor: "row-resize",
							// Subtle by default; only calls attention to itself on hover or while dragging,
							// so it doesn't clutter the input when the user isn't looking to resize it.
							backgroundColor: isDraggingMaxHeight
								? "var(--vscode-focusBorder)"
								: "var(--vscode-scrollbarSlider-background, transparent)",
							opacity: isDraggingMaxHeight ? 1 : 0.6,
							transition: isDraggingMaxHeight ? "none" : "background-color 0.1s ease-in-out",
						}}
						tabIndex={0}
						title="Drag to resize the prompt box"
					/>
					<div
						className={cn(
							"absolute bottom-2.5 top-2.5 whitespace-pre-wrap break-words rounded-xs overflow-hidden",
							isTextAreaFocused ? "left-3.5 right-3.5" : "left-3.5 right-3.5 border border-input-border",
						)}
						ref={highlightLayerRef}
						style={{
							position: "absolute",
							pointerEvents: "none",
							whiteSpace: "pre-wrap",
							wordWrap: "break-word",
							color: "transparent",
							overflow: "hidden",
							fontFamily: "var(--vscode-font-family)",
							fontSize: "var(--vscode-editor-font-size)",
							lineHeight: "var(--vscode-editor-line-height)",
							borderRadius: 2,
							borderLeft: isTextAreaFocused ? 0 : undefined,
							borderRight: isTextAreaFocused ? 0 : undefined,
							borderTop: isTextAreaFocused ? 0 : undefined,
							borderBottom: isTextAreaFocused ? 0 : undefined,
							padding: `9px 28px ${9 + thumbnailsHeight}px 9px`,
							backgroundColor:
								"var(--vscode-input-background, var(--vscode-editor-background, var(--vscode-sideBar-background, #1e1e1e)))",
						}}
					/>
					<DynamicTextArea
						autoFocus={true}
						data-testid="chat-input"
						maxRows={maxRows}
						minRows={3}
						onBlur={handleBlur}
						onChange={(e) => {
							handleInputChange(e)
							updateHighlights()
						}}
						onFocus={() => {
							setIsTextAreaFocused(true)
							onFocusChange?.(true) // Call prop on focus
						}}
						onHeightChange={(height) => {
							if (textAreaBaseHeight === undefined || height < textAreaBaseHeight) {
								setTextAreaBaseHeight(height)
							}
							onHeightChange?.(height)
						}}
						onKeyDown={handleKeyDown}
						onKeyUp={handleKeyUp}
						onMouseUp={updateCursorPosition}
						onPaste={handlePaste}
						onScroll={() => updateHighlights()}
						onSelect={updateCursorPosition}
						placeholder={showUnsupportedFileError || showDimensionError ? "" : placeholderText}
						ref={(el) => {
							if (typeof ref === "function") {
								ref(el)
							} else if (ref) {
								ref.current = el
							}
							textAreaRef.current = el
						}}
						style={{
							width: "100%",
							boxSizing: "border-box",
							backgroundColor:
								"var(--vscode-input-background, var(--vscode-editor-background, var(--vscode-sideBar-background, #1e1e1e)))",
							color: "var(--vscode-input-foreground, var(--vscode-foreground, #cccccc))",
							//border: "1px solid var(--vscode-input-border)",
							borderRadius: 2,
							fontFamily: "var(--vscode-font-family)",
							fontSize: "var(--vscode-editor-font-size)",
							lineHeight: "var(--vscode-editor-line-height)",
							resize: "none",
							overflowX: "hidden",
							overflowY: "scroll",
							scrollbarWidth: "none",
							// Since we have maxRows, when text is long enough it starts to overflow the bottom padding, appearing behind the thumbnails. To fix this, we use a transparent border to push the text up instead. (https://stackoverflow.com/questions/42631947/maintaining-a-padding-inside-of-text-area/52538410#52538410)
							// borderTop: "9px solid transparent",
							borderLeft: 0,
							borderRight: 0,
							borderTop: 0,
							borderBottom: `${thumbnailsHeight}px solid transparent`,
							borderColor: "transparent",
							// borderRight: "54px solid transparent",
							// borderLeft: "9px solid transparent", // NOTE: react-textarea-autosize doesn't calculate correct height when using borderLeft/borderRight so we need to use horizontal padding instead
							// Instead of using boxShadow, we use a div with a border to better replicate the behavior when the textarea is focused
							// boxShadow: "0px 0px 0px 1px var(--vscode-input-border)",
							padding: "9px 28px 9px 9px",
							cursor: "text",
							flex: 1,
							zIndex: 1,
							outline:
								isDraggingOver && !showUnsupportedFileError // Only show drag outline if not showing error
									? "2px dashed var(--vscode-focusBorder)"
									: isTextAreaFocused
										? `1px solid ${mode === "plan" ? PLAN_MODE_COLOR : "var(--vscode-focusBorder)"}`
										: "none",
							outlineOffset: isDraggingOver && !showUnsupportedFileError ? "1px" : "0px", // Add offset for drag-over outline
						}}
						value={inputValue}
					/>
					{!inputValue && selectedImages.length === 0 && selectedFiles.length === 0 && (
						<div className="text-xs absolute bottom-5 left-6.5 right-16 text-(--vscode-input-placeholderForeground)/50 whitespace-nowrap overflow-hidden text-ellipsis pointer-events-none z-1">
							Type @ for context, / for slash commands & workflows, hold shift to drag in files/images
						</div>
					)}
					{(selectedImages.length > 0 || selectedFiles.length > 0) && (
						<Thumbnails
							files={selectedFiles}
							images={selectedImages}
							imagesUnsupported={unsupportedImagesAttached}
							onHeightChange={handleThumbnailsHeightChange}
							setFiles={setSelectedFiles}
							setImages={setSelectedImages}
							style={{
								position: "absolute",
								paddingTop: 4,
								bottom: 14,
								left: 22,
								right: 47, // (54 + 9) + 4 extra padding
								zIndex: 2,
							}}
						/>
					)}
					<div
						className="absolute flex items-end bottom-4.5 right-5 z-10 h-8 text-xs"
						style={{ height: textAreaBaseHeight }}>
						<div className="relative flex flex-row items-center gap-1">
							<div
								aria-label={SEND_MODE_META[sendMode].label}
								className={cn(
									"input-icon-button",
									{ disabled: sendingDisabled },
									"codicon",
									SEND_MODE_META[sendMode].icon,
									"text-sm",
								)}
								data-send-mode={sendMode}
								data-testid="send-button"
								onClick={() => {
									if (!sendingDisabled) {
										triggerSend()
									}
								}}
								title={SEND_MODE_META[sendMode].tooltip}
							/>
							{!showSchedulePicker && (
								<div className="relative flex h-5 w-4 items-center justify-center" title="Choose send mode">
									<span
										aria-hidden="true"
										className="codicon codicon-chevron-down text-[10px] pointer-events-none"
									/>
									{/* Invisible native select over the chevron keeps keyboard and
										    screen-reader support. Choosing an option only changes the
										    sticky send mode; it never sends. */}
									<select
										aria-label="Send mode"
										className="absolute inset-0 cursor-pointer opacity-0"
										data-testid="send-mode-select"
										onChange={(e) => {
											const mode = e.target.value as SendMode
											setSendMode(mode)
											saveSendMode(mode)
										}}
										style={{
											backgroundColor:
												"var(--vscode-dropdown-background, var(--vscode-input-background, var(--vscode-sideBar-background)))",
											color: "var(--vscode-dropdown-foreground, var(--vscode-input-foreground, var(--vscode-foreground)))",
										}}
										value={sendMode}>
										{SEND_MODES.map((mode) => (
											<option key={mode} value={mode}>
												{mode === sendMode ? "✓ " : " "}
												{SEND_MODE_META[mode].label}
											</option>
										))}
									</select>
								</div>
							)}
							{showSchedulePicker && (
								<div
									className="absolute bottom-full right-0 z-20 mb-2 flex flex-col gap-2 rounded-[3px] border border-editor-group-border p-3 shadow-md"
									style={{
										backgroundColor:
											"var(--vscode-editorWidget-background, var(--vscode-sideBar-background))",
									}}>
									<div className="flex flex-wrap items-center gap-2">
										<ScheduleTimeInput onChange={setScheduleTime} value={scheduleTime} />
									</div>
									<div className="flex flex-wrap items-center gap-2">
										<ScheduleRepeatInput
											count={repeatCount}
											every={repeatEvery}
											onCountChange={setRepeatCount}
											onEveryChange={setRepeatEvery}
											onUnitChange={setRepeatUnit}
											unit={repeatUnit}
										/>
									</div>
									<div className="flex justify-end gap-2">
										<button
											className="flex h-7 items-center rounded-[3px] border border-editor-group-border px-3 text-xs text-description hover:text-foreground"
											onClick={() => {
												setShowSchedulePicker(false)
												setScheduleTime("")
												setRepeatCount(1)
											}}
											type="button">
											Cancel
										</button>
										<button
											className="flex h-7 items-center rounded-[3px] bg-primary px-3 text-xs text-primary-foreground disabled:opacity-50"
											disabled={!scheduleTime || sendingDisabled}
											onClick={confirmSchedule}
											type="button">
											Schedule
										</button>
									</div>
								</div>
							)}
						</div>
					</div>
				</div>
				{unsupportedImagesAttached && (
					<div
						className="flex items-center gap-1.5 px-3.5 pb-1.5 text-xs"
						data-testid="images-unsupported-notice"
						role="status"
						style={{ color: "var(--vscode-editorWarning-foreground)" }}>
						<TriangleAlertIcon className="shrink-0" size={12} />
						<span className="min-w-0">
							{selectedModelId} doesn't support images, so{" "}
							{selectedImages.length === 1 ? "the attached image" : `the ${selectedImages.length} attached images`}{" "}
							will be ignored.{" "}
							<button
								className="underline cursor-pointer bg-transparent border-0 p-0 m-0 text-[var(--vscode-textLink-foreground)] hover:text-[var(--vscode-textLink-activeForeground)]"
								data-testid="images-unsupported-choose-model"
								onClick={handleModelButtonClick}
								type="button">
								Choose an image-capable model
							</button>{" "}
							or remove {selectedImages.length === 1 ? "it" : "them"}.
						</span>
					</div>
				)}
				<div className="flex justify-between items-center -mt-[2px] px-3 pb-2">
					{/* Always render both components, but control visibility with CSS */}
					<div className="relative flex-1 min-w-0 h-5">
						<ModelButton
							handleContextButtonClick={handleContextButtonClick}
							mode={mode}
							onSelectFilesAndImages={onSelectFilesAndImages}
							shouldDisableFilesAndImages={shouldDisableFilesAndImages}
						/>
					</div>
					{/* Tooltip for Plan/Act toggle remains outside the conditional rendering */}
					<ModeSwitch mode={mode} onModeToggle={onModeToggle} togglePlanActKeys={togglePlanActKeys} />
				</div>
			</div>
		)
	},
)

export default ChatTextArea
