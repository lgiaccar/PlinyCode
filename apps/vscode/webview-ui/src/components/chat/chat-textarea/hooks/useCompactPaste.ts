import { useEffect, useState } from "react"
import { isLongPrompt, wordCount } from "../../compactPrompt"

interface PasteBlock {
	label: string
	text: string
}

interface Draft {
	full: string
	display: string
	blocks: PasteBlock[]
}

/** The parent owns the original text; placeholders exist only inside the composer. */
export function useCompactPaste(full: string, setFull: (value: string) => void) {
	const [draft, setDraft] = useState<Draft>({ full, display: full, blocks: [] })
	const [sequence, setSequence] = useState(0)
	// Sending, recalling, restoring or replacing the draft invalidates its old display projection.
	const current = draft.full === full ? draft : { full, display: full, blocks: [] }
	useEffect(() => {
		setDraft((previous) => (previous.full === full ? previous : { full, display: full, blocks: [] }))
	}, [full])
	const expandText = (display: string, blocks: PasteBlock[]) => {
		const retained = blocks.filter((block) => display.includes(block.label))
		// One pass: pasted text that happens to contain another label is never interpreted as a placeholder.
		let expanded = ""
		let offset = 0
		while (offset < display.length) {
			const next = retained
				.map((block) => ({ block, index: display.indexOf(block.label, offset) }))
				.filter(({ index }) => index >= 0)
				.sort((a, b) => a.index - b.index)[0]
			if (!next) {
				expanded += display.slice(offset)
				break
			}
			expanded += display.slice(offset, next.index) + next.block.text
			offset = next.index + next.block.label.length
		}
		return expanded
	}
	const commit = (display: string, blocks: PasteBlock[]) => {
		const expanded = expandText(display, blocks)
		// Keep removed blocks for native undo until the parent replaces the draft.
		setDraft({ full: expanded, display, blocks })
		setFull(expanded)
	}
	const selectionRange = (start: number, end: number) => {
		// Treat a collapsed block as a unit when an edit or selection crosses its label.
		for (const block of current.blocks) {
			const at = current.display.indexOf(block.label)
			if (at >= 0 && start < at + block.label.length && end > at) {
				start = Math.min(start, at)
				end = Math.max(end, at + block.label.length)
			}
		}
		return { start, end }
	}
	const replace = (start: number, end: number, text: string, blocks = current.blocks) => {
		const range = selectionRange(start, end)
		commit(current.display.slice(0, range.start) + text + current.display.slice(range.end), blocks)
		return range.start + text.length
	}
	return {
		value: current.display,
		blocks: current.blocks.filter((block) => current.display.includes(block.label)),
		copy: (start: number, end: number) => {
			const range = selectionRange(start, end)
			return expandText(current.display.slice(range.start, range.end), current.blocks)
		},
		cut: (start: number, end: number) => replace(start, end, ""),
		setValue: (value: string) => {
			let start = 0
			while (start < value.length && start < current.display.length && value[start] === current.display[start]) start++
			let end = current.display.length
			let newEnd = value.length
			while (end > start && newEnd > start && current.display[end - 1] === value[newEnd - 1]) {
				end--
				newEnd--
			}
			return replace(start, end, value.slice(start, newEnd))
		},
		paste: (text: string, start: number, end: number): number | undefined => {
			if (!isLongPrompt(text)) return undefined
			let id = sequence + 1
			let label: string
			do {
				label = `[Pasted text #${id}: ${wordCount(text).toLocaleString()} words]`
				id++
			} while (current.display.includes(label) || text.includes(label))
			setSequence(id - 1)
			return replace(start, end, label, [...current.blocks, { label, text }])
		},
		expand: () => {
			setDraft({ full, display: full, blocks: [] })
		},
	}
}
