import { memo } from "react"
import { updateSetting } from "@/components/settings/utils/settingsHandlers"
import { Switch } from "@/components/ui/switch"
import { useExtensionState } from "@/context/ExtensionStateContext"

/**
 * Shown on the latest completion card when checkpoints are off so users can
 * enable them without hunting through Settings -> Features.
 */
export const CheckpointsEnablePrompt = memo(() => {
	const { enableCheckpointsSetting } = useExtensionState()
	const enabled = enableCheckpointsSetting ?? true

	return (
		<div className="flex items-center justify-between gap-3 rounded-sm border border-success/20 bg-background/40 px-2 py-1.5 text-xs text-description">
			<span>Enable checkpoints to see a summary of file changes after each run (requires a git workspace).</span>
			<div className="flex shrink-0 items-center gap-2">
				<label className="sr-only" htmlFor="completion-checkpoints-toggle">
					Checkpoints
				</label>
				<Switch
					checked={enabled}
					id="completion-checkpoints-toggle"
					onCheckedChange={(checked) => updateSetting("enableCheckpointsSetting", checked)}
					size="lg"
				/>
			</div>
		</div>
	)
})

CheckpointsEnablePrompt.displayName = "CheckpointsEnablePrompt"
