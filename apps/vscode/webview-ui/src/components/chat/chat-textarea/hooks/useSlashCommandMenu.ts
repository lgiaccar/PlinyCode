import { type SlashCommand } from "@shared/slashCommands"
import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { insertSlashCommand } from "@/utils/slash-commands"

/**
 * The /slash-command menu: its open/selection/search state and the handler
 * that applies a selection to the textarea. `setInputValue`/`textAreaRef` are
 * used to write the result back into the shared textarea state that lives in
 * the parent component; `setIntendedCursorPosition` is the context menu
 * hook's cursor-restore signal, shared across both menus.
 */
export function useSlashCommandMenu(
	setInputValue: (value: string) => void,
	textAreaRef: React.RefObject<HTMLTextAreaElement | null>,
	cursorPosition: number,
	setCursorPosition: (position: number) => void,
	setIntendedCursorPosition: (position: number | null) => void,
) {
	const [showSlashCommandsMenu, setShowSlashCommandsMenu] = useState(false)
	const [selectedSlashCommandsIndex, setSelectedSlashCommandsIndex] = useState(0)
	const [slashCommandsQuery, setSlashCommandsQuery] = useState("")
	const slashCommandsMenuContainerRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		const handleClickOutsideSlashMenu = (event: MouseEvent) => {
			if (slashCommandsMenuContainerRef.current && !slashCommandsMenuContainerRef.current.contains(event.target as Node)) {
				setShowSlashCommandsMenu(false)
			}
		}

		if (showSlashCommandsMenu) {
			document.addEventListener("mousedown", handleClickOutsideSlashMenu)
		}

		return () => {
			document.removeEventListener("mousedown", handleClickOutsideSlashMenu)
		}
	}, [showSlashCommandsMenu])

	const handleSlashCommandsSelect = useCallback(
		(command: SlashCommand) => {
			setShowSlashCommandsMenu(false)
			const queryLength = slashCommandsQuery.length
			setSlashCommandsQuery("")

			if (textAreaRef.current) {
				const { newValue, commandIndex } = insertSlashCommand(
					textAreaRef.current.value,
					command.name,
					queryLength,
					cursorPosition,
				)
				const newCursorPosition = newValue.indexOf(" ", commandIndex + 1 + command.name.length) + 1

				setInputValue(newValue)
				setCursorPosition(newCursorPosition)
				setIntendedCursorPosition(newCursorPosition)

				setTimeout(() => {
					if (textAreaRef.current) {
						textAreaRef.current.blur()
						textAreaRef.current.focus()
					}
				}, 0)
			}
		},
		[setInputValue, slashCommandsQuery, cursorPosition, textAreaRef, setCursorPosition, setIntendedCursorPosition],
	)

	return {
		showSlashCommandsMenu,
		setShowSlashCommandsMenu,
		selectedSlashCommandsIndex,
		setSelectedSlashCommandsIndex,
		slashCommandsQuery,
		setSlashCommandsQuery,
		slashCommandsMenuContainerRef,
		handleSlashCommandsSelect,
	}
}
