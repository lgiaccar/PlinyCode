import { useState } from "react"
import MemoryPanel from "@/components/settings/MemoryPanel"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"

export default function MemoryInboxBanner() {
	const { memoryPendingCount = 0 } = useExtensionState()
	const [open, setOpen] = useState(false)
	if (!memoryPendingCount && !open) return null
	return (
		<div className="p-2 border-b border-description/20 max-h-72 overflow-y-auto text-xs">
			<div className="flex items-center justify-between gap-2">
				<span>{memoryPendingCount} memories proposed from earlier conversations.</span>
				<Button onClick={() => setOpen(!open)} size="sm" variant="secondary">
					{open ? "Close" : "Review"}
				</Button>
			</div>
			{open && <MemoryPanel inboxOnly />}
		</div>
	)
}
