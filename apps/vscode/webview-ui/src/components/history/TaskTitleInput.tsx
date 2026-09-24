import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

interface TaskTitleInputProps {
	initialTitle: string
	/** Called with the trimmed title when it is non-blank and changed. */
	onCommit: (title: string) => void
	/** Called after a commit, a blank/unchanged submit, or Escape. */
	onDone: () => void
	className?: string
}

/** Inline editor for a conversation title: Enter or blur saves, Escape cancels. */
const TaskTitleInput = ({ initialTitle, onCommit, onDone, className }: TaskTitleInputProps) => {
	const [value, setValue] = useState(initialTitle)
	const inputRef = useRef<HTMLInputElement>(null)
	const finishedRef = useRef(false)

	useEffect(() => {
		inputRef.current?.focus()
		inputRef.current?.select()
	}, [])

	const finish = (save: boolean) => {
		if (finishedRef.current) {
			return
		}
		finishedRef.current = true
		const trimmed = value.trim()
		if (save && trimmed && trimmed !== initialTitle.trim()) {
			onCommit(trimmed)
		}
		onDone()
	}

	return (
		<input
			aria-label="Conversation name"
			className={cn(
				"w-full min-w-0 rounded-xs border border-(--vscode-focusBorder) bg-(--vscode-input-background) px-1 py-0.5 text-(--vscode-input-foreground) outline-none",
				className,
			)}
			onBlur={() => finish(true)}
			onChange={(e) => setValue(e.target.value)}
			onClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => {
				e.stopPropagation()
				if (e.key === "Enter") {
					e.preventDefault()
					finish(true)
				} else if (e.key === "Escape") {
					e.preventDefault()
					finish(false)
				}
			}}
			ref={inputRef}
			type="text"
			value={value}
		/>
	)
}

export default TaskTitleInput
