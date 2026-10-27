import { useRef, useState } from "react"
import { Switch } from "@/components/ui/switch"

export type BulkToggleTarget = {
	enabled: boolean
	toggle: (enabled: boolean) => Promise<unknown>
}

const BulkToggleControl = ({
	kind,
	targets,
	onRefresh,
	onBusyChange,
}: {
	kind: "rules" | "skills"
	targets: BulkToggleTarget[]
	onRefresh: () => Promise<void>
	onBusyChange: (busy: boolean) => void
}) => {
	const applying = useRef(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState("")
	const enabledCount = targets.filter((target) => target.enabled).length

	const toggleAll = async (enabled: boolean) => {
		if (applying.current) return
		applying.current = true
		setBusy(true)
		onBusyChange(true)
		setError("")
		let failures = 0
		try {
			// These RPCs return entire toggle maps. Apply them serially so later
			// writes and state broadcasts cannot overwrite earlier changes.
			for (const target of targets) {
				if (target.enabled === enabled) continue
				try {
					await target.toggle(enabled)
				} catch (cause) {
					failures++
					console.error(`Failed to update ${kind} in bulk:`, cause)
				}
			}
			await onRefresh()
			if (failures > 0)
				setError(`Could not update all ${kind} (${failures} failed). Check the individual switches and try again.`)
		} catch (cause) {
			console.error(`Failed to refresh ${kind} after bulk update:`, cause)
			setError(`Could not refresh ${kind}. Reopen Customize to check their state.`)
		} finally {
			applying.current = false
			setBusy(false)
			onBusyChange(false)
		}
	}

	return (
		<div className="mb-3">
			<div className="flex items-center justify-between gap-2 text-xs">
				<div>
					<span className="font-medium">All {kind}</span>
					<span aria-live="polite" className="ml-2 text-description">
						{busy ? "Updating…" : `${enabledCount} of ${targets.length} enabled`}
					</span>
				</div>
				<Switch
					aria-label={`Toggle all ${kind}`}
					checked={enabledCount > 0}
					disabled={busy || targets.length === 0}
					onCheckedChange={(enabled) => void toggleAll(enabled)}
					title={`Switch off to disable all ${kind}; switch on to enable all ${kind}, globally and in this workspace.`}
				/>
			</div>
			{error && (
				<p className="mb-0 mt-2 text-xs text-error" role="alert">
					{error}
				</p>
			)}
		</div>
	)
}

export default BulkToggleControl
