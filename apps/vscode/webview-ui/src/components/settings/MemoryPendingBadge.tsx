import { useExtensionState } from "@/context/ExtensionStateContext"

export function MemoryPendingBadge() {
	const { memoryPendingCount = 0 } = useExtensionState()
	return memoryPendingCount > 0 ? (
		<span
			aria-label="Pending memory proposals"
			className="rounded px-1 bg-badge-background text-badge-foreground"
			role="status">
			{memoryPendingCount}
		</span>
	) : null
}
