import type React from "react"
import { useCallback, useLayoutEffect, useRef, useState } from "react"

/** Shortest a prompt can be dragged to, in pixels (about two lines). */
export const MIN_PROMPT_HEIGHT = 40
const KEYBOARD_STEP = 24

// Heights the user dragged prompts to, by message timestamp. Module-level so a
// row that the virtualized list unmounts, or the task header's copy that
// remounts when the header is folded, comes back at the same height.
const heightsByMessage = new Map<number, number>()

/** Test hook: forget every remembered height. */
export function resetRememberedPromptHeights(): void {
	heightsByMessage.clear()
}

interface ResizablePromptTextProps {
	children: React.ReactNode
	/** Height the text is cut to until the user drags it, in pixels. */
	defaultMaxHeight: number
	/** Remembers the dragged height for this message across remounts. */
	messageTs?: number
	/** Re-measures when the content changes. */
	contentKey?: unknown
}

/**
 * A prompt's text, cut to a default height with a scrollbar, and a grip on its
 * bottom edge that drags it taller or shorter (up to the full text).
 * Double-clicking the grip switches between the full text and the default
 * height. Clicks on the grip and the scrollbar stay inside, so they never
 * open the prompt for editing.
 */
const ResizablePromptText: React.FC<ResizablePromptTextProps> = ({ children, defaultMaxHeight, messageTs, contentKey }) => {
	const scrollRef = useRef<HTMLDivElement>(null)
	const dragRef = useRef<{ startY: number; startHeight: number; pointerId: number } | undefined>(undefined)
	const [height, setHeightState] = useState<number | undefined>(() =>
		messageTs !== undefined ? heightsByMessage.get(messageTs) : undefined,
	)
	const [overflows, setOverflows] = useState(false)

	const setHeight = useCallback(
		(next: number | undefined) => {
			setHeightState(next)
			if (messageTs === undefined) {
				return
			}
			if (next === undefined) {
				heightsByMessage.delete(messageTs)
			} else {
				heightsByMessage.set(messageTs, next)
			}
		},
		[messageTs],
	)

	const contentHeight = () => scrollRef.current?.scrollHeight ?? 0
	const clampHeight = (value: number) => Math.round(Math.max(MIN_PROMPT_HEIGHT, Math.min(value, contentHeight())))

	// Whether there is more text than shows, so the grip is worth showing.
	useLayoutEffect(() => {
		const element = scrollRef.current
		if (!element) {
			return
		}
		const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1)
		measure()
		if (typeof ResizeObserver === "undefined") {
			return
		}
		const observer = new ResizeObserver(measure)
		observer.observe(element)
		return () => observer.disconnect()
	}, [contentKey, height])

	const showGrip = overflows || height !== undefined

	const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		const element = scrollRef.current
		if (!element || event.button !== 0) {
			return
		}
		event.preventDefault()
		event.stopPropagation()
		dragRef.current = {
			startY: event.clientY,
			startHeight: element.getBoundingClientRect().height,
			pointerId: event.pointerId,
		}
		event.currentTarget.setPointerCapture?.(event.pointerId)
	}

	const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current
		if (!drag || drag.pointerId !== event.pointerId) {
			return
		}
		event.preventDefault()
		setHeight(clampHeight(drag.startHeight + event.clientY - drag.startY))
	}

	const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
		if (dragRef.current?.pointerId !== event.pointerId) {
			return
		}
		dragRef.current = undefined
		event.currentTarget.releasePointerCapture?.(event.pointerId)
	}

	const toggleFullText = () => {
		const full = contentHeight()
		const current = scrollRef.current?.clientHeight ?? 0
		setHeight(current < full - 1 ? Math.max(MIN_PROMPT_HEIGHT, full) : undefined)
	}

	const onGripKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const current = scrollRef.current?.getBoundingClientRect().height ?? 0
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			setHeight(clampHeight(current + (event.key === "ArrowDown" ? KEYBOARD_STEP : -KEYBOARD_STEP)))
		} else if (event.key === "Enter" || event.key === " ") {
			toggleFullText()
		} else {
			return
		}
		event.preventDefault()
		event.stopPropagation()
	}

	// A click on the scrollbar lands on the scroll box itself, past its client
	// width; keep it from opening the prompt for editing.
	const onScrollBoxClick = (event: React.MouseEvent<HTMLDivElement>) => {
		const element = event.currentTarget
		if (event.target === element && event.nativeEvent.offsetX >= element.clientWidth) {
			event.stopPropagation()
		}
	}

	return (
		<div className="flex flex-col">
			<div
				className="overflow-y-auto overflow-x-hidden"
				data-testid="prompt-text-scroll"
				onClick={onScrollBoxClick}
				ref={scrollRef}
				style={height !== undefined ? { height } : { maxHeight: defaultMaxHeight }}>
				{children}
			</div>
			{showGrip && (
				<div
					aria-label="Resize prompt. Drag, or use the up and down arrow keys; double-click or Enter shows the whole prompt."
					aria-orientation="horizontal"
					aria-valuemin={MIN_PROMPT_HEIGHT}
					aria-valuenow={height ?? defaultMaxHeight}
					className="group/grip flex h-2.5 -mb-1.5 items-center justify-center cursor-ns-resize touch-none select-none outline-none focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
					data-testid="prompt-resize-grip"
					onClick={(event) => event.stopPropagation()}
					onDoubleClick={(event) => {
						event.stopPropagation()
						toggleFullText()
					}}
					onKeyDown={onGripKeyDown}
					onLostPointerCapture={() => {
						dragRef.current = undefined
					}}
					onPointerCancel={endDrag}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={endDrag}
					role="separator"
					tabIndex={0}
					title="Drag to resize · double-click to show the whole prompt">
					<span className="block h-[3px] w-8 rounded-full bg-badge-foreground opacity-30 group-hover/grip:opacity-70 group-focus-visible/grip:opacity-70" />
				</div>
			)}
		</div>
	)
}

export default ResizablePromptText
