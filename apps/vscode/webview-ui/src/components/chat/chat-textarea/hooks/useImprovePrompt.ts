import { ImprovePromptRequest } from "@shared/proto/cline/task"
import type { Mode } from "@shared/storage/types"
import type React from "react"
import { useCallback, useEffect, useState } from "react"
import { TaskServiceClient } from "@/services/grpc-client"

interface UseImprovePromptOptions {
	inputValue: string
	setInputValue: (value: string) => void
	mode: Mode
	textAreaRef: React.RefObject<HTMLTextAreaElement | null>
	/** Called after the draft was replaced, e.g. to put the cursor at its end. */
	onReplaced?: (text: string) => void
}

/**
 * The "Improve prompt" button's state. The draft is sent to a small free
 * model; its rewrite replaces the draft only if the draft is still what was
 * sent (the user may keep typing while it runs), and can be undone until the
 * user edits it.
 */
export function useImprovePrompt({ inputValue, setInputValue, mode, textAreaRef, onReplaced }: UseImprovePromptOptions) {
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string>()
	const [replaced, setReplaced] = useState<{ original: string; improved: string }>()

	// Any edit ends the undo offer and clears a stale error.
	useEffect(() => {
		setReplaced((current) => (current && current.improved !== inputValue ? undefined : current))
		setError(undefined)
	}, [inputValue])

	const improve = useCallback(async () => {
		const submitted = inputValue
		if (!submitted.trim() || pending) {
			return
		}
		setPending(true)
		setError(undefined)
		setReplaced(undefined)
		try {
			const result = await TaskServiceClient.improvePrompt(ImprovePromptRequest.create({ text: submitted, mode }))
			if ((textAreaRef.current?.value ?? submitted) !== submitted) {
				// The user kept typing: their draft wins and the rewrite is dropped.
				return
			}
			if (result.error || !result.text) {
				setError(result.error || "The prompt could not be improved.")
				return
			}
			setInputValue(result.text)
			setReplaced({ original: submitted, improved: result.text })
			onReplaced?.(result.text)
		} catch (err) {
			setError(`The prompt could not be improved: ${err instanceof Error ? err.message : String(err)}`)
		} finally {
			setPending(false)
		}
	}, [inputValue, pending, mode, textAreaRef, setInputValue, onReplaced])

	const undo = useCallback(() => {
		if (replaced) {
			setInputValue(replaced.original)
			setReplaced(undefined)
			onReplaced?.(replaced.original)
		}
	}, [replaced, setInputValue, onReplaced])

	return { pending, error, canUndo: replaced !== undefined, improve, undo }
}
