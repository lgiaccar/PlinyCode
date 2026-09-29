import { mentionRegex } from "@shared/context-mentions"
import type { McpServer } from "@shared/mcp"
import type { SlashCommand } from "@shared/slashCommands"
import type React from "react"
import { useCallback } from "react"
import {
	ContextMenuOptionType,
	type ContextMenuQueryItem,
	getContextMenuOptions,
	removeMention,
	type SearchResult,
} from "@/utils/context-mentions"
import { isSafari } from "@/utils/platformUtils"
import { getMatchingSlashCommands, removeSlashCommand, slashCommandDeleteRegex } from "@/utils/slash-commands"

/**
 * The chat textarea's onKeyDown router: select-all, the slash-command and
 * context menus' own key handling (Escape/Arrow/Enter/Tab, each taking
 * priority over plain typing while its menu is open), sending on Enter, and
 * the two-step backspace-deletes-a-mention-or-slash-command behavior. It
 * reads and writes state that's split across `useContextMenu`,
 * `useSlashCommandMenu` and the parent component itself, so everything it
 * needs is threaded through as parameters rather than duplicated.
 */
export function useComposerKeyboardHandler(params: {
	inputValue: string
	setInputValue: (value: string) => void
	cursorPosition: number
	setCursorPosition: (position: number) => void
	setIntendedCursorPosition: (position: number | null) => void
	sendingDisabled: boolean
	triggerSend: () => void
	textAreaRef: React.RefObject<HTMLTextAreaElement | null>
	localWorkflowToggles: Record<string, boolean>
	globalWorkflowToggles: Record<string, boolean>
	mcpServers: McpServer[]
	// Context menu (@-mentions)
	showContextMenu: boolean
	setShowContextMenu: (show: boolean) => void
	selectedMenuIndex: number
	setSelectedMenuIndex: React.Dispatch<React.SetStateAction<number>>
	selectedType: ContextMenuOptionType | null
	setSelectedType: (type: ContextMenuOptionType | null) => void
	searchQuery: string
	setSearchQuery: (query: string) => void
	queryItems: ContextMenuQueryItem[]
	fileSearchResults: SearchResult[]
	handleMentionSelect: (type: ContextMenuOptionType, value?: string) => void
	justDeletedSpaceAfterMention: boolean
	setJustDeletedSpaceAfterMention: (value: boolean) => void
	defaultContextMenuOption: number
	// Slash command menu
	showSlashCommandsMenu: boolean
	setShowSlashCommandsMenu: (show: boolean) => void
	selectedSlashCommandsIndex: number
	setSelectedSlashCommandsIndex: React.Dispatch<React.SetStateAction<number>>
	slashCommandsQuery: string
	setSlashCommandsQuery: (query: string) => void
	handleSlashCommandsSelect: (command: SlashCommand) => void
	justDeletedSpaceAfterSlashCommand: boolean
	setJustDeletedSpaceAfterSlashCommand: (value: boolean) => void
}) {
	const {
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
		defaultContextMenuOption,
		showSlashCommandsMenu,
		setShowSlashCommandsMenu,
		selectedSlashCommandsIndex,
		setSelectedSlashCommandsIndex,
		slashCommandsQuery,
		setSlashCommandsQuery,
		handleSlashCommandsSelect,
		justDeletedSpaceAfterSlashCommand,
		setJustDeletedSpaceAfterSlashCommand,
	} = params

	return useCallback(
		(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
			const isSelectAllShortcut =
				(event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "a"
			if (isSelectAllShortcut) {
				event.preventDefault()
				event.stopPropagation()
				const textArea = event.currentTarget
				textArea.setSelectionRange(0, textArea.value.length)
				setCursorPosition(0)
				return
			}

			if (showSlashCommandsMenu) {
				if (event.key === "Escape") {
					setShowSlashCommandsMenu(false)
					setSlashCommandsQuery("")
					return
				}

				if (event.key === "ArrowUp" || event.key === "ArrowDown") {
					event.preventDefault()
					setSelectedSlashCommandsIndex((prevIndex) => {
						const direction = event.key === "ArrowUp" ? -1 : 1
						// Get commands with workflow toggles
						const allCommands = getMatchingSlashCommands(
							slashCommandsQuery,
							localWorkflowToggles,
							globalWorkflowToggles,
							mcpServers,
						)

						if (allCommands.length === 0) {
							return prevIndex
						}

						// Calculate total command count
						const totalCommandCount = allCommands.length

						// Create wraparound navigation - moves from last item to first and vice versa
						const newIndex = (prevIndex + direction + totalCommandCount) % totalCommandCount
						return newIndex
					})
					return
				}

				if ((event.key === "Enter" || event.key === "Tab") && selectedSlashCommandsIndex !== -1) {
					event.preventDefault()
					const commands = getMatchingSlashCommands(
						slashCommandsQuery,
						localWorkflowToggles,
						globalWorkflowToggles,
						mcpServers,
					)
					if (commands.length > 0) {
						handleSlashCommandsSelect(commands[selectedSlashCommandsIndex])
					}
					return
				}
			}
			if (showContextMenu) {
				if (event.key === "Escape") {
					setShowContextMenu(false)
					setSelectedType(null)
					setSelectedMenuIndex(defaultContextMenuOption)
					setSearchQuery("")
					return
				}

				if (event.key === "ArrowUp" || event.key === "ArrowDown") {
					event.preventDefault()
					setSelectedMenuIndex((prevIndex) => {
						const direction = event.key === "ArrowUp" ? -1 : 1
						const options = getContextMenuOptions(searchQuery, selectedType, queryItems, fileSearchResults)
						const optionsLength = options.length

						if (optionsLength === 0) {
							return prevIndex
						}

						// Find selectable options (non-URL types)
						const selectableOptions = options.filter(
							(option) =>
								option.type !== ContextMenuOptionType.URL && option.type !== ContextMenuOptionType.NoResults,
						)

						if (selectableOptions.length === 0) {
							return -1 // No selectable options
						}

						// Find the index of the next selectable option
						const currentSelectableIndex = selectableOptions.indexOf(options[prevIndex])

						const newSelectableIndex =
							(currentSelectableIndex + direction + selectableOptions.length) % selectableOptions.length

						// Find the index of the selected option in the original options array
						return options.indexOf(selectableOptions[newSelectableIndex])
					})
					return
				}
				if ((event.key === "Enter" || event.key === "Tab") && selectedMenuIndex !== -1) {
					event.preventDefault()
					const selectedOption = getContextMenuOptions(searchQuery, selectedType, queryItems, fileSearchResults)[
						selectedMenuIndex
					]
					if (
						selectedOption &&
						selectedOption.type !== ContextMenuOptionType.URL &&
						selectedOption.type !== ContextMenuOptionType.NoResults
					) {
						// Use label if it contains workspace prefix, otherwise use value
						const mentionValue = selectedOption.label?.includes(":") ? selectedOption.label : selectedOption.value
						handleMentionSelect(selectedOption.type, mentionValue)
					}
					return
				}
			}

			// Safari does not support InputEvent.isComposing (always false), so we need to fallback to keyCode === 229 for it
			const isComposing = isSafari ? event.nativeEvent.keyCode === 229 : (event.nativeEvent?.isComposing ?? false)
			if (event.key === "Enter" && !event.shiftKey && !isComposing) {
				event.preventDefault()

				if (!sendingDisabled) {
					// Note: don't set isTextAreaFocused to false here. The textarea keeps
					// DOM focus after sending, and clearing the flag without an actual
					// blur desyncs it permanently (programmatic .focus() on an
					// already-focused element never re-fires onFocus), which hides the
					// plan/act mode outline until a real blur/refocus cycle.
					triggerSend()
				}
			}

			if (event.key === "Backspace" && !isComposing) {
				const charBeforeCursor = inputValue[cursorPosition - 1]
				const charAfterCursor = inputValue[cursorPosition + 1]

				const charBeforeIsWhitespace =
					charBeforeCursor === " " || charBeforeCursor === "\n" || charBeforeCursor === "\r\n"
				const charAfterIsWhitespace = charAfterCursor === " " || charAfterCursor === "\n" || charAfterCursor === "\r\n"

				// Check if we're right after a space that follows a mention or slash command
				if (
					charBeforeIsWhitespace &&
					inputValue.slice(0, cursorPosition - 1).match(new RegExp(mentionRegex.source + "$"))
				) {
					// File mention handling
					const newCursorPosition = cursorPosition - 1
					if (!charAfterIsWhitespace) {
						event.preventDefault()
						textAreaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
						setCursorPosition(newCursorPosition)
					}
					setCursorPosition(newCursorPosition)
					setJustDeletedSpaceAfterMention(true)
					setJustDeletedSpaceAfterSlashCommand(false)
				} else if (charBeforeIsWhitespace && inputValue.slice(0, cursorPosition - 1).match(slashCommandDeleteRegex)) {
					// New slash command handling
					const newCursorPosition = cursorPosition - 1
					if (!charAfterIsWhitespace) {
						event.preventDefault()
						textAreaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
						setCursorPosition(newCursorPosition)
					}
					setCursorPosition(newCursorPosition)
					setJustDeletedSpaceAfterSlashCommand(true)
					setJustDeletedSpaceAfterMention(false)
				}
				// Handle the second backspace press for mentions or slash commands
				else if (justDeletedSpaceAfterMention) {
					const { newText, newPosition } = removeMention(inputValue, cursorPosition)
					if (newText !== inputValue) {
						event.preventDefault()
						setInputValue(newText)
						setIntendedCursorPosition(newPosition)
					}
					setJustDeletedSpaceAfterMention(false)
					setShowContextMenu(false)
				} else if (justDeletedSpaceAfterSlashCommand) {
					// New slash command deletion
					const { newText, newPosition } = removeSlashCommand(inputValue, cursorPosition)
					if (newText !== inputValue) {
						event.preventDefault()
						setInputValue(newText)
						setIntendedCursorPosition(newPosition)
					}
					setJustDeletedSpaceAfterSlashCommand(false)
					setShowSlashCommandsMenu(false)
				}
				// Default case - reset flags if none of the above apply
				else {
					setJustDeletedSpaceAfterMention(false)
					setJustDeletedSpaceAfterSlashCommand(false)
				}
			}
		},
		[
			triggerSend,
			showContextMenu,
			searchQuery,
			selectedMenuIndex,
			handleMentionSelect,
			selectedType,
			inputValue,
			cursorPosition,
			setInputValue,
			justDeletedSpaceAfterMention,
			queryItems,
			fileSearchResults,
			showSlashCommandsMenu,
			selectedSlashCommandsIndex,
			slashCommandsQuery,
			handleSlashCommandsSelect,
			sendingDisabled,
			setCursorPosition,
			setSelectedType,
			setSelectedMenuIndex,
			setSearchQuery,
			setShowContextMenu,
			setShowSlashCommandsMenu,
			setSlashCommandsQuery,
			setSelectedSlashCommandsIndex,
			setJustDeletedSpaceAfterMention,
			setIntendedCursorPosition,
			localWorkflowToggles,
			globalWorkflowToggles,
			mcpServers,
			textAreaRef,
			justDeletedSpaceAfterSlashCommand,
			setJustDeletedSpaceAfterSlashCommand,
			defaultContextMenuOption,
		],
	)
}
