import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ContextInspector } from "./ContextInspector"

export function ContextInspectorButton() {
	const { currentTaskItem } = useExtensionState()
	const [open, setOpen] = useState(false)
	if (!currentTaskItem) return null
	return (
		<>
			<button
				className="text-xs text-description"
				onClick={() => setOpen(true)}
				title="Inspect captured model requests"
				type="button">
				Context
			</button>
			{open && <ContextInspector onClose={() => setOpen(false)} taskId={currentTaskItem.id} />}
		</>
	)
}
