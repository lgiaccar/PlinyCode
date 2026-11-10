import { InboxIcon } from "lucide-react"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AttentionInbox } from "./AttentionInbox"

export function AttentionButton() {
	const [open, setOpen] = useState(false)
	const { backgroundTasks, turnState } = useExtensionState()
	const waiting =
		(backgroundTasks?.filter((task) => task.status === "needs_attention").length ?? 0) +
		(turnState?.phase === "awaiting_approval" || turnState?.phase === "awaiting_followup" ? 1 : 0)
	return (
		<>
			<button className="inline-flex items-center gap-1 text-xs min-h-7 px-2" onClick={() => setOpen(true)} type="button">
				<InboxIcon size={14} /> Needs attention{waiting > 0 ? ` (${waiting})` : ""}
			</button>
			{open && <AttentionInbox onClose={() => setOpen(false)} />}
		</>
	)
}
