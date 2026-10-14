import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { updateSetting } from "@/components/settings/utils/settingsHandlers"

// Chat prompt textarea max-height drag handle: keeps the resize affordance's clamps
// and default in one place so the JSX below and any tests agree on the numbers.
const DEFAULT_CHAT_INPUT_MAX_ROWS = 10
export const MIN_CHAT_INPUT_MAX_ROWS = 3 // never below minRows
const MAX_CHAT_INPUT_MAX_ROWS = 40 // generous upper bound so a drag can't cover the whole editor
const DEFAULT_ROW_HEIGHT_PX = 18 // fallback if line-height can't be measured (matches ~13px font * 1.35 line-height)

/**
 * The height the conversation always keeps, however tall the prompt box gets:
 * a quarter of the panel, at least 120px, at most half of it. ChatLayout puts
 * the CSS form in its grid, and `fittingRows` caps the prompt box with the
 * pixel form, so neither can squeeze the other to nothing.
 */
export const MIN_CONVERSATION_CSS = "min(max(120px, 25vh), 50vh)"

function minConversationPx(viewportPx: number): number {
	return Math.min(Math.max(120, viewportPx * 0.25), viewportPx * 0.5)
}

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
 * `upperRows` lowers the upper bound, e.g. to the rows that fit the panel.
 */
export function rowsFromDrag(
	startMaxRows: number,
	deltaYPx: number,
	rowHeightPx: number,
	upperRows = MAX_CHAT_INPUT_MAX_ROWS,
): number {
	const deltaRows = Math.round(-deltaYPx / rowHeightPx)
	const nextRows = startMaxRows + deltaRows
	return Math.min(upperRows, MAX_CHAT_INPUT_MAX_ROWS, Math.max(MIN_CHAT_INPUT_MAX_ROWS, nextRows))
}

interface FitMeasure {
	viewportPx: number
	/** The whole footer: the prompt box and everything around it (toolbars, queued prompts…). */
	footerPx: number
	/** The textarea element, padding and borders included. */
	textAreaPx: number
	/** The textarea's padding and borders. */
	textAreaChromePx: number
	rowHeightPx: number
}

/**
 * The most rows the textarea can show while the conversation keeps its
 * minimum height: what is left of the viewport once the conversation's
 * minimum and the rest of the footer are taken. Never below one row.
 */
export function fittingRows(m: FitMeasure): number {
	const aroundTextArea = Math.max(0, Math.round(m.footerPx - m.textAreaPx))
	const room = m.viewportPx - minConversationPx(m.viewportPx) - aroundTextArea - m.textAreaChromePx
	return Math.max(1, Math.floor(room / m.rowHeightPx))
}

const CHROME_PROPERTIES = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"] as const

/**
 * The rows that fit the panel (see `fittingRows`), measured again whenever the
 * window or the footer around the textarea changes size. Undefined while the
 * textarea is not laid out (a hidden view, or a test without layout), which
 * means no cap.
 */
export function useFittingRows(textAreaRef: React.RefObject<HTMLTextAreaElement | null>): number | undefined {
	const [fit, setFit] = useState<number>()
	useEffect(() => {
		const textArea = textAreaRef.current
		const footer = textArea?.closest("footer")
		if (!textArea || !footer) {
			return
		}
		const measure = () => {
			const footerPx = footer.getBoundingClientRect().height
			const textAreaPx = textArea.getBoundingClientRect().height
			if (!footerPx || !textAreaPx) {
				setFit(undefined)
				return
			}
			const style = window.getComputedStyle(textArea)
			const textAreaChromePx = CHROME_PROPERTIES.reduce((sum, key) => sum + (Number.parseFloat(style[key]) || 0), 0)
			setFit(
				fittingRows({
					viewportPx: window.innerHeight,
					footerPx,
					textAreaPx,
					textAreaChromePx,
					rowHeightPx: getRowHeightPx(textArea),
				}),
			)
		}
		measure()
		window.addEventListener("resize", measure)
		// The footer grows when queued prompts, thumbnails or a notice appear above the textarea.
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure)
		observer?.observe(footer)
		return () => {
			window.removeEventListener("resize", measure)
			observer?.disconnect()
		}
	}, [textAreaRef])
	return fit
}

/**
 * User-draggable cap on the textarea's height, in rows (react-textarea-autosize's
 * maxRows). Starts from the persisted setting and is kept in sync with it (e.g.
 * another window changing it), except while the user is actively dragging this
 * window's handle. mousemove/mouseup listen on window for the duration of the
 * drag so the drag keeps tracking even if the cursor leaves the handle; the
 * setting is only persisted on mouseup so we don't spam writes on every tick.
 *
 * `fitRows` is how many rows fit the panel (`useFittingRows`). The textarea
 * shows `shownMaxRows`, the smaller of the two, and a drag starts from and
 * stops at what fits, so the handle always responds and the conversation
 * keeps its minimum height.
 */
export function useResizableRows(
	persistedChatInputMaxRows: number | undefined,
	textAreaRef: React.RefObject<HTMLTextAreaElement | null>,
	fitRows?: number,
) {
	const [maxRows, setMaxRows] = useState<number>(persistedChatInputMaxRows ?? DEFAULT_CHAT_INPUT_MAX_ROWS)
	const isDraggingMaxHeightRef = useRef(false)
	const dragStartRef = useRef<{ startY: number; startMaxRows: number; rowHeightPx: number } | null>(null)
	const [isDraggingMaxHeight, setIsDraggingMaxHeight] = useState(false)
	const upperRows = Math.max(MIN_CHAT_INPUT_MAX_ROWS, Math.min(MAX_CHAT_INPUT_MAX_ROWS, fitRows ?? MAX_CHAT_INPUT_MAX_ROWS))
	const shownMaxRows = fitRows === undefined ? maxRows : Math.max(1, Math.min(maxRows, fitRows))

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
			dragStartRef.current = { startY: e.clientY, startMaxRows: Math.min(maxRows, upperRows), rowHeightPx }
			isDraggingMaxHeightRef.current = true
			setIsDraggingMaxHeight(true)

			const handleMouseMove = (moveEvent: MouseEvent) => {
				const dragStart = dragStartRef.current
				if (!dragStart) {
					return
				}
				const deltaY = moveEvent.clientY - dragStart.startY
				setMaxRows(rowsFromDrag(dragStart.startMaxRows, deltaY, dragStart.rowHeightPx, upperRows))
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
		[maxRows, upperRows, textAreaRef],
	)

	return {
		maxRows,
		setMaxRows,
		shownMaxRows,
		upperRows,
		isDraggingMaxHeight,
		handleMaxHeightDragMouseDown,
	}
}
