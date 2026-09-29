import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { updateSetting } from "@/components/settings/utils/settingsHandlers"

// Chat prompt textarea max-height drag handle: keeps the resize affordance's clamps
// and default in one place so the JSX below and any tests agree on the numbers.
const DEFAULT_CHAT_INPUT_MAX_ROWS = 10
export const MIN_CHAT_INPUT_MAX_ROWS = 3 // never below minRows
export const MAX_CHAT_INPUT_MAX_ROWS = 40 // generous upper bound so a drag can't cover the whole editor
const DEFAULT_ROW_HEIGHT_PX = 18 // fallback if line-height can't be measured (matches ~13px font * 1.35 line-height)

/**
 * Reads the textarea's line-height in pixels, the same metric
 * react-textarea-autosize itself uses to translate maxRows into a max-height.
 * Falls back to a sane default when the element isn't mounted yet or the
 * computed line-height can't be parsed (e.g. "normal" in a test environment
 * without full layout).
 */
export function getRowHeightPx(element: HTMLElement | null): number {
	if (!element) {
		return DEFAULT_ROW_HEIGHT_PX
	}
	const computed = window.getComputedStyle(element)
	const parsed = Number.parseFloat(computed.lineHeight)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ROW_HEIGHT_PX
}

/**
 * Converts a vertical drag delta (in pixels, positive = dragging the handle up,
 * which grows the textarea) into a new maxRows value, clamped to sane bounds.
 */
export function rowsFromDrag(startMaxRows: number, deltaYPx: number, rowHeightPx: number): number {
	const deltaRows = Math.round(-deltaYPx / rowHeightPx)
	const nextRows = startMaxRows + deltaRows
	return Math.min(MAX_CHAT_INPUT_MAX_ROWS, Math.max(MIN_CHAT_INPUT_MAX_ROWS, nextRows))
}

/**
 * User-draggable cap on the textarea's height, in rows (react-textarea-autosize's
 * maxRows). Starts from the persisted setting and is kept in sync with it (e.g.
 * another window changing it), except while the user is actively dragging this
 * window's handle. mousemove/mouseup listen on window for the duration of the
 * drag so the drag keeps tracking even if the cursor leaves the handle; the
 * setting is only persisted on mouseup so we don't spam writes on every tick.
 */
export function useResizableRows(
	persistedChatInputMaxRows: number | undefined,
	textAreaRef: React.RefObject<HTMLTextAreaElement | null>,
) {
	const [maxRows, setMaxRows] = useState<number>(persistedChatInputMaxRows ?? DEFAULT_CHAT_INPUT_MAX_ROWS)
	const isDraggingMaxHeightRef = useRef(false)
	const dragStartRef = useRef<{ startY: number; startMaxRows: number; rowHeightPx: number } | null>(null)
	const [isDraggingMaxHeight, setIsDraggingMaxHeight] = useState(false)

	// Pick up external changes to the persisted setting (e.g. changed in another
	// window), but don't fight the user's in-progress drag in this one.
	useEffect(() => {
		if (isDraggingMaxHeightRef.current) {
			return
		}
		setMaxRows(persistedChatInputMaxRows ?? DEFAULT_CHAT_INPUT_MAX_ROWS)
	}, [persistedChatInputMaxRows])

	const handleMaxHeightDragMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault()
			const rowHeightPx = getRowHeightPx(textAreaRef.current)
			dragStartRef.current = { startY: e.clientY, startMaxRows: maxRows, rowHeightPx }
			isDraggingMaxHeightRef.current = true
			setIsDraggingMaxHeight(true)

			const handleMouseMove = (moveEvent: MouseEvent) => {
				const dragStart = dragStartRef.current
				if (!dragStart) {
					return
				}
				const deltaY = moveEvent.clientY - dragStart.startY
				setMaxRows(rowsFromDrag(dragStart.startMaxRows, deltaY, dragStart.rowHeightPx))
			}

			const handleMouseUp = () => {
				window.removeEventListener("mousemove", handleMouseMove)
				window.removeEventListener("mouseup", handleMouseUp)
				isDraggingMaxHeightRef.current = false
				setIsDraggingMaxHeight(false)
				dragStartRef.current = null
				// Persist on release only, using the latest committed value.
				setMaxRows((current) => {
					updateSetting("chatInputMaxRows", current)
					return current
				})
			}

			window.addEventListener("mousemove", handleMouseMove)
			window.addEventListener("mouseup", handleMouseUp)
		},
		[maxRows, textAreaRef],
	)

	return {
		maxRows,
		setMaxRows,
		isDraggingMaxHeight,
		handleMaxHeightDragMouseDown,
	}
}
